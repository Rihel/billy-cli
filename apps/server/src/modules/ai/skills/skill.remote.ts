import { Octokit } from '@octokit/rest'
import {
  SKILL_FILE_MAX_CHARS,
  SKILL_FILE_PATH_PATTERN,
  SKILL_MAX_FILES,
  SKILL_TOTAL_MAX_CHARS,
} from '@repo/shared'
import { validateSkillFileContent } from '../core/skills/skill.content.js'
import { parseSkillMarkdown } from '../core/skills/skill.draft.js'
import { SKILL_FILE } from '../core/skills/skill.paths.js'
import { fetchGuarded } from '../tools/web/http.js'
import { describeSkillSource, parseSkillSource, type ParsedSkillSource } from './skill.source.js'

/**
 * 从链接下载技能（skills.sh / GitHub / 直接 Markdown 链接）—— 设计 §2.5。
 *
 * 三条口径：
 * - **GitHub 交互用 `@octokit/rest`**（官方 SDK）：树、contents、限额与错误码都由它处理，
 *   不自己拼 API 路径 / 判状态码；文件内容优先走 raw（不受 API 限额），失败再回落到 contents；
 * - **只读，不写库**：这里只把远端内容取成"待导入草稿"，校验与入库在 service；
 * - **白名单 + 限额**：只收 `SKILL.md` 与 `references/` `scripts/` `assets/` 下的文本文件，
 *   跳符号链接 / 二进制 / 超大文件，超出限额**报失败**而不是截断。
 *
 * 为什么不用整仓 tarball：大仓库（如 `anthropics/skills`）压缩包几 MB，
 * 实测这个网络下 90s 都下不完；而文件树只有 ~170KB、秒级返回，按需再取文件更快也更省。
 * 未认证的 GitHub API 限额是 60 次/时/IP：本功能是管理员低频操作，可接受；
 * 需要更高上限时配 `GITHUB_TOKEN`（只影响 API 调用，raw 文件不占这个额度）。
 */

const GITHUB_API = 'https://api.github.com'
const RAW_BASE = 'https://raw.githubusercontent.com'
/** 一次导入最多处理几个技能（防止把整个仓库的技能都灌进来） */
const MAX_SKILLS_PER_IMPORT = 25
/** 单文件读取上限（内容上限的 UTF-8 倍数，先按字节卡一道，避免把大文件读进内存） */
const MAX_READ_BYTES = SKILL_FILE_MAX_CHARS * 4
/** 文件树缓存（预览 + 导入不该打两次 API） */
const TREE_TTL_MS = 5 * 60_000

/** 允许导入的文本扩展名（扩展名 + 读取后无 NUL 字节双重判断） */
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.sh',
  '.bash',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.csv',
  '.html',
  '.css',
  '.sql',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.php',
  '.lua',
  '.ps1',
])

/** 一个待导入的技能（还没入库） */
export interface RemoteSkillSource {
  skillKey: string
  description: string
  /** 用户给的原始链接（入库存进 `origin_url`，便于追溯 / 重装） */
  originUrl: string
  /** 全部文件（相对技能目录，POSIX 形式） */
  files: { path: string; content: string }[]
  /** 被跳过的文件（不支持的路径 / 扩展名 / 二进制），在导入结果里附一条说明 */
  skipped: string[]
}

export interface RemoteFetchResult {
  /** 人读的来源（`owner/repo[/slug]`） */
  label: string
  sources: RemoteSkillSource[]
  /** 扫描阶段的失败（一个坏技能不影响其它技能） */
  failures: { skillKey: string; message: string }[]
}

interface TreeEntry {
  path: string
  mode: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  size?: number
}

const treeCache = new Map<string, { at: number; entries: TreeEntry[] }>()

/** 下载一个链接里的全部技能 */
export const fetchRemoteSkillSources = async (input: string): Promise<RemoteFetchResult> => {
  const parsed = parseSkillSource(input)
  const label = describeSkillSource(parsed)
  const originUrl = input.trim()

  if (parsed.kind === 'markdown') {
    const source = await fetchSingleMarkdown(parsed.url, originUrl)
    return { label, sources: [source], failures: [] }
  }

  const ref = parsed.ref ?? 'HEAD'
  const entries = await loadTree(parsed.owner, parsed.repo, ref)
  const dirs = collectSkillDirs(entries, parsed)

  if (dirs.length === 0) {
    const hint = parsed.slug ? `（仓库里没有名为 ${parsed.slug} 的技能）` : ''
    return {
      label,
      sources: [],
      failures: [
        { skillKey: parsed.slug ?? parsed.subpath ?? label, message: `没有找到 SKILL.md${hint}` },
      ],
    }
  }
  if (dirs.length > MAX_SKILLS_PER_IMPORT) {
    return {
      label,
      sources: [],
      failures: [
        {
          skillKey: label,
          message: `这个链接下有 ${dirs.length} 个技能，超过单次上限 ${MAX_SKILLS_PER_IMPORT}；请给具体技能的链接`,
        },
      ],
    }
  }

  const sources: RemoteSkillSource[] = []
  const failures: { skillKey: string; message: string }[] = []
  for (const dir of dirs) {
    try {
      sources.push(await buildSkillSource(parsed, ref, dir, entries, originUrl))
    } catch (error) {
      failures.push({ skillKey: dir.split('/').pop() || label, message: messageOf(error) })
    }
  }
  return { label, sources, failures }
}

// ─────────────────────────── GitHub ───────────────────────────

/** 文件树：`HEAD` 是 GitHub API 接受的默认分支引用（实测可用），省掉一次"查默认分支"的调用 */
const loadTree = async (owner: string, repo: string, ref: string): Promise<TreeEntry[]> => {
  const key = `${owner}/${repo}@${ref}`
  const cached = treeCache.get(key)
  if (cached && Date.now() - cached.at < TREE_TTL_MS) return cached.entries

  try {
    const { data } = await getClient().rest.git.getTree({
      owner,
      repo,
      tree_sha: ref,
      recursive: '1',
    })
    if (data.truncated) {
      throw new Error('仓库文件树太大（GitHub 返回 truncated），请改用具体技能目录的链接')
    }
    const entries = (data.tree ?? []).filter(
      (entry): entry is TreeEntry =>
        (entry.type === 'blob' || entry.type === 'tree' || entry.type === 'commit') &&
        typeof entry.path === 'string' &&
        typeof entry.sha === 'string',
    )
    treeCache.set(key, { at: Date.now(), entries })
    return entries
  } catch (error) {
    throw new Error(describeGitHubError(error, `${owner}/${repo}`))
  }
}

/** 从文件树里挑出"技能目录"（含 SKILL.md 的目录） */
const collectSkillDirs = (
  entries: readonly TreeEntry[],
  parsed: Extract<ParsedSkillSource, { kind: 'github' }>,
): string[] => {
  const dirs = entries
    .filter((entry) => entry.type === 'blob')
    .filter((entry) => entry.path === SKILL_FILE || entry.path.endsWith(`/${SKILL_FILE}`))
    .map((entry) =>
      entry.path === SKILL_FILE ? '' : entry.path.slice(0, -`/${SKILL_FILE}`.length),
    )
    .filter((dir) => !isIgnoredPath(dir))

  let filtered = dirs
  if (parsed.subpath) {
    const sub = parsed.subpath.replace(/\/+$/, '')
    filtered = filtered.filter(
      (dir) => dir === sub || dir.startsWith(`${sub}/`) || sub.startsWith(`${dir}/`),
    )
  }
  if (parsed.slug) {
    const bySlug = filtered.filter((dir) => (dir.split('/').pop() ?? '') === parsed.slug)
    if (bySlug.length > 0) filtered = bySlug
  }
  return [...new Set(filtered)].sort()
}

/** 取一个技能目录下的全部允许文件并校验 */
const buildSkillSource = async (
  parsed: Extract<ParsedSkillSource, { kind: 'github' }>,
  ref: string,
  dir: string,
  entries: readonly TreeEntry[],
  originUrl: string,
): Promise<RemoteSkillSource> => {
  const prefix = dir ? `${dir}/` : ''
  const nestedDirs = entries
    .filter((entry) => entry.type === 'blob' && entry.path.startsWith(prefix))
    .filter((entry) => entry.path === SKILL_FILE || entry.path.endsWith(`/${SKILL_FILE}`))
    .map((entry) => entry.path.slice(0, -`/${SKILL_FILE}`.length))
    .filter((nested) => nested && nested !== dir)
    .map((nested) => `${nested}/`)

  const candidates = entries
    .filter((entry) => entry.type === 'blob' && entry.path.startsWith(prefix))
    .filter((entry) => !nestedDirs.some((nested) => entry.path.startsWith(nested)))
    .map((entry) => ({ entry, relative: entry.path.slice(prefix.length) }))
    .sort((left, right) => left.relative.localeCompare(right.relative))

  const files: { path: string; content: string }[] = []
  const skipped: string[] = []
  let totalChars = 0

  for (const { entry, relative } of candidates) {
    if (entry.mode === '120000') {
      skipped.push(`${relative}（符号链接）`)
      continue
    }
    if (!SKILL_FILE_PATH_PATTERN.test(relative)) {
      skipped.push(`${relative}（不支持的路径）`)
      continue
    }
    const dot = relative.lastIndexOf('.')
    const extension = dot >= 0 ? relative.slice(dot).toLowerCase() : ''
    if (!TEXT_EXTENSIONS.has(extension)) {
      skipped.push(`${relative}（非文本扩展名）`)
      continue
    }
    const content = await readRepoFile(parsed.owner, parsed.repo, ref, entry.path)
    if (content.includes('\u0000')) {
      skipped.push(`${relative}（二进制内容）`)
      continue
    }
    if (content.length > SKILL_FILE_MAX_CHARS) {
      throw new Error(
        `${relative} 内容 ${content.length} 字符，超过单文件上限 ${SKILL_FILE_MAX_CHARS}`,
      )
    }
    totalChars += content.length
    files.push({ path: relative, content })
  }

  if (files.length > SKILL_MAX_FILES)
    throw new Error(`文件数 ${files.length} 超过上限 ${SKILL_MAX_FILES}`)
  if (totalChars > SKILL_TOTAL_MAX_CHARS) {
    throw new Error(`全部文件合计 ${totalChars} 字符，超过上限 ${SKILL_TOTAL_MAX_CHARS}`)
  }
  const entry = files.find((file) => file.path === SKILL_FILE)
  if (!entry) throw new Error(`缺少 ${SKILL_FILE}`)

  // 技能名以 **frontmatter 的 name** 为准（GitHub 上目录名与技能名不一定一致；
  // 落盘时目录就是 skillKey，Mastra 校验时自然一致）
  const loose = validateSkillFileContent({ content: entry.content })
  if (!loose.valid) throw new Error(loose.errors.join('；'))
  const name = typeof loose.metadata?.name === 'string' ? loose.metadata.name : null
  if (!name) throw new Error('SKILL.md 缺少 frontmatter.name，无法确定技能名')

  const parsedSkill = parseSkillMarkdown(entry.content, name)
  if (!parsedSkill.parsed) throw new Error(parsedSkill.errors.join('；'))

  return {
    skillKey: parsedSkill.parsed.skillKey,
    description: parsedSkill.parsed.description,
    originUrl,
    files,
    skipped,
  }
}

/** 读一个仓库文件：优先 raw（不占 API 限额），失败再走 contents API */
const readRepoFile = async (
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<string> => {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const raw = await fetchText(
    `${RAW_BASE}/${owner}/${repo}/${ref}/${encodedPath}`,
    MAX_READ_BYTES,
  ).catch(() => null)
  if (raw && raw.status === 200) return raw.text

  try {
    const { data } = await getClient().rest.repos.getContent({ owner, repo, path, ref })
    if (Array.isArray(data) || !('content' in data) || typeof data.content !== 'string') {
      throw new Error(`读不到文件：${path}`)
    }
    return Buffer.from(
      data.content,
      (data.encoding as BufferEncoding | undefined) ?? 'base64',
    ).toString('utf8')
  } catch (error) {
    throw new Error(describeGitHubError(error, `${owner}/${repo}/${path}`))
  }
}

// ─────────────────────────── Octokit ───────────────────────────

let client: Octokit | null = null

const getClient = (): Octokit => {
  if (client) return client
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  client = new Octokit({
    ...(token ? { auth: token } : {}),
    userAgent: 'billy-skill-library',
    baseUrl: GITHUB_API,
    request: { timeout: 30_000 },
  })
  return client
}

/** 把 Octokit 的错误翻译成能直接给人看的中文 */
const describeGitHubError = (error: unknown, target: string): string => {
  const status = (error as { status?: number }).status
  if (status === 404) return `GitHub 上找不到：${target}（也可能是私有仓库）`
  if (status === 403 || status === 429) {
    return 'GitHub 接口限额已用尽（未配置 GITHUB_TOKEN 时约 60 次/小时）；稍后再试或配置令牌'
  }
  if (status === 401) return 'GITHUB_TOKEN 无效或已过期'
  return `读取 GitHub 失败：${messageOf(error)}`
}

// ─────────────────────────── 直接 Markdown 链接 ───────────────────────────

const fetchSingleMarkdown = async (url: string, originUrl: string): Promise<RemoteSkillSource> => {
  const response = await fetchText(url, MAX_READ_BYTES)
  if (response.status !== 200) throw new Error(`下载失败（HTTP ${response.status}）：${url}`)
  if (response.text.length > SKILL_FILE_MAX_CHARS) {
    throw new Error(`文件 ${response.text.length} 字符，超过单文件上限 ${SKILL_FILE_MAX_CHARS}`)
  }
  const loose = validateSkillFileContent({ content: response.text })
  if (!loose.valid) throw new Error(loose.errors.join('；'))
  const name = typeof loose.metadata?.name === 'string' ? loose.metadata.name : null
  if (!name) throw new Error('这份 SKILL.md 缺少 frontmatter.name，无法确定技能名')

  const parsed = parseSkillMarkdown(response.text, name)
  if (!parsed.parsed) throw new Error(parsed.errors.join('；'))

  return {
    skillKey: parsed.parsed.skillKey,
    description: parsed.parsed.description,
    originUrl,
    files: [{ path: SKILL_FILE, content: response.text }],
    skipped: ['仅导入了 SKILL.md（直接链接受限，不含同目录的 references/scripts）'],
  }
}

/** 直接 Markdown 链接走统一出网守卫（同 web 工具一套 SSRF / 超时预算） */
const fetchText = async (
  url: string,
  maxBytes: number,
): Promise<{ status: number; text: string }> => {
  try {
    const response = await fetchGuarded(url, {
      headers: { 'User-Agent': 'billy-skill-library' },
      timeoutMs: 20_000,
      maxBytes,
      allowPrivateNetwork: false,
    })
    return { status: response.status, text: response.text }
  } catch (error) {
    throw new Error(messageOf(error))
  }
}

/** 跳过隐藏目录 / 依赖目录（`.github` / `.vc` / `node_modules` 里的示例技能不是给人装的） */
const isIgnoredPath = (path: string): boolean =>
  path
    .split('/')
    .some(
      (segment) =>
        segment.startsWith('.') ||
        segment === 'node_modules' ||
        segment === 'dist' ||
        segment === 'coverage',
    )

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
