import { dirname } from 'node:path'
import parseGithubUrl from 'parse-github-url'

/**
 * 技能来源链接解析（**纯函数，无 IO**）。
 *
 * 支持的写法（设计见 `docs/design/ai-skill-library.md` §2.5）：
 * - skills.sh：`https://skills.sh/<owner>/<repo>[/<slug>]`
 * - GitHub：仓库 / 目录 / 文件页（`/tree/<ref>/<path>`、`/blob/<ref>/.../SKILL.md`）
 * - raw：`https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`
 * - 简写：`<owner>/<repo>[/<slug>]`
 * - 直接 Markdown 链接：其它站点上的一份 `SKILL.md`（单文件技能）
 *
 * GitHub 形态的解析用 **`parse-github-url`**（成熟包，边界情况比自己写正则可靠），
 * 只有 skills.sh / 简写这类"不是 GitHub URL"的形态由本文件补一层映射 ——
 * skills.sh 的技能本来就托管在 GitHub，解析成 `owner/repo[/slug]` 后直接按仓库下载。
 * 第三方 well-known 来源（`/site/<domain>/...`）无 GitHub 仓库可折，会明确报"暂不支持"。
 */

/** 解析后的来源 */
export type ParsedSkillSource =
  | {
      kind: 'github'
      owner: string
      repo: string
      /** 分支 / tag / commit（缺省用仓库默认分支） */
      ref?: string
      /** 仓库内子路径（目录或 `SKILL.md` 文件） */
      subpath?: string
      /** skills.sh 的技能 slug（用于在仓库里定位目录） */
      slug?: string
    }
  | { kind: 'markdown'; url: string }

const isName = (value: string | null | undefined): value is string =>
  Boolean(value) && /^[A-Za-z0-9_.-]+$/.test(value!) && value !== '.' && value !== '..'

/**
 * 把用户输入解析成来源。不合法时抛错（错误信息要能直接展示给人看）。
 */
export const parseSkillSource = (input: string): ParsedSkillSource => {
  const trimmed = input.trim().replace(/[?#].*$/, '').replace(/\/+$/, '')
  if (!trimmed) throw new Error('请填写技能来源链接')

  // 简写：owner/repo 或 owner/repo/slug（parse-github-url 会把第三段丢掉，单独处理）
  if (!trimmed.includes('://')) {
    const parts = trimmed.split('/').filter(Boolean)
    if (parts.length === 2 || parts.length === 3) {
      const [owner, repo, slug] = parts
      if (isName(owner) && isName(repo) && (!slug || isName(slug))) {
        return {
          kind: 'github',
          owner,
          repo: repo.replace(/\.git$/, ''),
          ...(slug ? { slug } : {}),
        }
      }
    }
    throw new Error(`看不懂这个来源：${input}。支持 owner/repo、skills.sh 链接或 GitHub 链接`)
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`不是合法的链接：${input}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('只支持 http(s) 链接')
  }

  if (url.hostname === 'skills.sh' || url.hostname === 'www.skills.sh') {
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (segments[0] === 'p') throw new Error('skills.sh 的 Pack 链接暂不支持，请打开单个技能页面再复制链接')
    if (segments[0] === 'site') {
      throw new Error('skills.sh 上的第三方站点来源暂不支持（它不托管在 GitHub），请改用 GitHub 链接')
    }
    const [owner, repo, slug] = segments
    if (!isName(owner) || !isName(repo)) throw new Error(`skills.sh 链接格式不对：${url.pathname}`)
    return {
      kind: 'github',
      owner,
      repo,
      ...(isName(slug) ? { slug } : {}),
    }
  }

  const parsed = parseGithubUrl(trimmed)
  if (!parsed) throw new Error(`不认识的链接：${input}`)
  const host = parsed.hostname ?? ''

  if (host === 'github.com' || host === 'www.github.com') {
    if (!isName(parsed.owner) || !isName(parsed.name)) {
      throw new Error(`GitHub 链接格式不对：${url.pathname}`)
    }
    const ref = hasRefSegment(url.pathname) ? parsed.branch ?? undefined : undefined
    let subpath: string | undefined
    if (url.pathname.includes('/tree/')) {
      // tree 链接的子路径 parse-github-url 不返回，按 "/<owner>/<repo>/tree/<branch>/" 前缀切
      const marker = `/${parsed.owner}/${parsed.name}/tree/${parsed.branch}/`
      if (url.pathname.startsWith(marker)) subpath = url.pathname.slice(marker.length) || undefined
    } else if (url.pathname.includes('/blob/')) {
      subpath = parsed.filepath ? dirname(parsed.filepath) : undefined
      if (subpath === '.') subpath = undefined
    }
    return {
      kind: 'github',
      owner: parsed.owner!,
      repo: parsed.name.replace(/\.git$/, ''),
      ...(ref ? { ref } : {}),
      ...(subpath ? { subpath } : {}),
    }
  }

  if (host === 'raw.githubusercontent.com') {
    if (!isName(parsed.owner) || !isName(parsed.name) || !parsed.branch) {
      throw new Error('raw 链接格式不对，需要 /<owner>/<repo>/<ref>/<path>')
    }
    const subpath = parsed.filepath ? dirname(parsed.filepath) : ''
    return {
      kind: 'github',
      owner: parsed.owner!,
      repo: parsed.name,
      ref: parsed.branch,
      ...(subpath && subpath !== '.' ? { subpath } : {}),
    }
  }

  // 其它站点上的直接 Markdown 链接：单文件技能
  if (url.pathname.toLowerCase().endsWith('.md')) return { kind: 'markdown', url: url.href }
  throw new Error(
    `不支持的来源：${url.hostname}。请用 skills.sh 链接、GitHub 链接，或直接指向 SKILL.md 的链接`,
  )
}

/** URL 里有没有显式的分支段（没有 = 用默认分支，不要信 parser 猜的 master） */
const hasRefSegment = (pathname: string): boolean =>
  pathname.includes('/tree/') || pathname.includes('/blob/') || pathname.includes('/commit/')

/** 人读的来源标签（列表 / 导入结果里展示） */
export const describeSkillSource = (parsed: ParsedSkillSource): string => {
  if (parsed.kind === 'markdown') return `直接链接 · ${new URL(parsed.url).hostname}`
  return [parsed.owner, parsed.repo, parsed.subpath ?? parsed.slug].filter(Boolean).join('/')
}
