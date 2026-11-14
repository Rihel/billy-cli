import { createHash } from 'node:crypto'
import { dump, load } from 'js-yaml'
import { SKILL_FILE_PATH_PATTERN, SKILL_KEY_PATTERN } from '@repo/shared'

/**
 * 技能库的纯函数规则层（**不依赖 Mastra、不做 IO**）。
 *
 * 为什么 main 要自带这一层：技能最终由 agent-runtime 的 Mastra 加载，但 main 是唯一的 CRUD
 * 服务，落库前必须把「技能名 / 文件路径 / SKILL.md 结构」校验掉。main 不装配 Mastra，
 * 所以这里按 Agent Skills 标准保留一份纯函数校验：
 * - 技能名 = 目录名：小写字母 / 数字 / 连字符，≤64；
 * - 文件路径白名单：`SKILL.md`，或 `references/` `scripts/` `assets/` 下的文本文件；
 * - frontmatter 必须是合法 YAML 对象，`name` 与目录名一致，`description` 非空且 ≤1024，
 *   `compatibility` ≤500。
 *
 * 与 runtime 的 `validateSkillFileContent` 口径保持一致；差异只在于「不调用 Mastra」。
 * 若将来 Mastra 的规则变化，需要同步这里（TODO：抽到 `@repo/shared` 后由两端共用）。
 */

/** 技能入口文件名（Agent Skills 标准） */
export const SKILL_FILE = 'SKILL.md'

/** 技能描述上限（与 Mastra 的硬校验一致） */
const DESCRIPTION_MAX = 1024

/** compatibility 上限（与 Mastra 的硬校验一致） */
const COMPATIBILITY_MAX = 500

/** 正文建议行数（超过只警告，不拦保存） */
const BODY_WARN_LINES = 500

/** 正文字符数换算 token 的粗略口径（超过只警告，不拦保存） */
const BODY_WARN_TOKENS = 5000

/** 技能名（= 目录名）是否合法 */
export const isValidSkillKey = (key: string): boolean => SKILL_KEY_PATTERN.test(key)

/** 归一化并校验技能名；不合法时抛错（调用方负责翻译成业务错误） */
export const normalizeSkillKey = (key: string): string => {
  const trimmed = key.trim()
  if (!isValidSkillKey(trimmed)) {
    throw new Error(
      `技能名不合法：${JSON.stringify(key)}（只能用 a-z / 0-9 / -，≤64，且以字母或数字开头）`,
    )
  }
  return trimmed
}

/** 归一化并校验技能内的相对路径（返回 POSIX 形式） */
export const normalizeSkillFilePath = (path: string): string => {
  const trimmed = path.trim()
  if (trimmed.includes('\\')) throw new Error(`技能文件路径不能包含反斜杠：${path}`)
  if (trimmed.startsWith('/')) throw new Error(`技能文件路径必须是相对路径：${path}`)
  if (trimmed.length > 200) throw new Error(`技能文件路径过长：${trimmed.length} 字符`)
  if (!SKILL_FILE_PATH_PATTERN.test(trimmed)) {
    throw new Error(
      `技能文件路径不合法：${path}（只能是 SKILL.md，或 references/ scripts/ assets/ 下的文件）`,
    )
  }
  if (trimmed.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`技能文件路径不能包含 . 或 .. 段：${path}`)
  }
  return trimmed
}

/** 文件类型：Markdown 用块编辑器，其余当代码 */
export const isMarkdownFile = (path: string): boolean => path.toLowerCase().endsWith('.md')

/** 一个技能草稿（页面 / 导入都归一到这个形状） */
export interface SkillDraft {
  skillKey: string
  description: string
  frontmatter: Record<string, unknown>
  body: string
}

/** 草稿校验结果 */
export interface SkillDraftValidation {
  content: string
  valid: boolean
  errors: string[]
  warnings: string[]
  metadata: Record<string, unknown>
}

/** 一份 SKILL.md 的校验结果（供导入与单文件校验使用） */
export interface SkillContentValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
  metadata: Record<string, unknown> | null
  instructions: string
}

/**
 * 把草稿拼成 `SKILL.md`。
 *
 * `name` / `description` **始终以入参为准**：frontmatter 里的同名字段被覆盖，
 * 避免「页面显示的是 A、文件里写的是 B」。
 */
export const buildSkillMarkdown = (draft: SkillDraft): string => {
  const data: Record<string, unknown> = {
    ...draft.frontmatter,
    name: draft.skillKey,
    description: draft.description,
  }
  const yaml = dump(data, { lineWidth: 0, noRefs: true, skipInvalid: true }).trimEnd()
  const body = draft.body.trim()
  return `---\n${yaml}\n---\n\n${body}${body ? '\n' : ''}`
}

/** 从一份完整的 `SKILL.md` 里拆出「元信息 + 正文」 */
export interface ParsedSkillMarkdown {
  skillKey: string
  description: string
  frontmatter: Record<string, unknown>
  body: string
  warnings: string[]
}

/** 校验一份 `SKILL.md` 全文（frontmatter + 正文） */
export const validateSkillFileContent = (input: {
  content: string
  /** 期望的目录名；给了就要求与 frontmatter.name 一致 */
  directoryName?: string
}): SkillContentValidation => {
  const { content, directoryName } = input
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content)
  if (!match) {
    return {
      valid: false,
      errors: ['SKILL.md 必须以 YAML frontmatter（--- 开头与结尾）开始'],
      warnings: [],
      metadata: null,
      instructions: '',
    }
  }

  let parsed: unknown
  try {
    parsed = load(match[1] ?? '')
  } catch (error) {
    return {
      valid: false,
      errors: [`frontmatter 不是合法的 YAML：${messageOf(error)}`],
      warnings: [],
      metadata: null,
      instructions: '',
    }
  }
  if (!isPlainObject(parsed)) {
    return {
      valid: false,
      errors: ['frontmatter 必须是 YAML 对象（key: value 形式）'],
      warnings: [],
      metadata: null,
      instructions: '',
    }
  }

  const metadata = parsed as Record<string, unknown>
  const errors: string[] = []
  const body = (match[2] ?? '').trim()

  const name = metadata.name
  if (typeof name !== 'string' || !name.trim()) {
    errors.push('frontmatter.name 必填且必须是字符串')
  } else if (!isValidSkillKey(name)) {
    errors.push(`frontmatter.name 不合法：${JSON.stringify(name)}（只能用 a-z / 0-9 / -，≤64）`)
  } else if (directoryName && name !== directoryName) {
    errors.push(`frontmatter.name（${name}）必须与技能目录名（${directoryName}）一致`)
  }

  const description = metadata.description
  if (typeof description !== 'string' || !description.trim()) {
    errors.push('frontmatter.description 不能为空（模型据此判断什么时候用这个技能）')
  } else if (description.length > DESCRIPTION_MAX) {
    errors.push(`frontmatter.description 长度 ${description.length} 超过上限 ${DESCRIPTION_MAX}`)
  }

  const compatibility = metadata.compatibility
  if (compatibility !== undefined) {
    if (typeof compatibility !== 'string') {
      errors.push('frontmatter.compatibility 必须是字符串')
    } else if (compatibility.length > COMPATIBILITY_MAX) {
      errors.push(
        `frontmatter.compatibility 长度 ${compatibility.length} 超过上限 ${COMPATIBILITY_MAX}`,
      )
    }
  }

  const warnings: string[] = []
  const lines = body ? body.split('\n').length : 0
  if (lines > BODY_WARN_LINES) {
    warnings.push(`正文 ${lines} 行，超过建议的 ${BODY_WARN_LINES} 行（会占用较多上下文）`)
  }
  const estimatedTokens = Math.ceil(body.length / 4)
  if (estimatedTokens > BODY_WARN_TOKENS) {
    warnings.push(
      `正文约 ${estimatedTokens} tokens，超过建议的 ${BODY_WARN_TOKENS}（会占用较多上下文）`,
    )
  }

  return { valid: errors.length === 0, errors, warnings, metadata, instructions: body }
}

/** 校验草稿（不抛错：把错误 / 警告原样带回去，由调用方决定怎么处置） */
export const validateSkillDraft = (draft: SkillDraft): SkillDraftValidation => {
  const content = buildSkillMarkdown(draft)
  const result = validateSkillFileContent({ content, directoryName: draft.skillKey })
  return {
    content,
    valid: result.valid,
    errors: result.valid ? [] : result.errors,
    warnings: result.warnings,
    metadata: result.metadata ?? {},
  }
}

/**
 * 解析并校验一份 `SKILL.md`（导入外部目录时用）。
 *
 * 返回 `null` 表示不合法；`errors` 由调用方翻译成「这个技能为什么没导入」。
 */
export const parseSkillMarkdown = (
  content: string,
  directoryName: string,
): { parsed: ParsedSkillMarkdown | null; errors: string[] } => {
  const result = validateSkillFileContent({ content, directoryName })
  if (!result.valid) return { parsed: null, errors: result.errors }

  const metadata = { ...result.metadata }
  const skillKey = typeof metadata.name === 'string' ? metadata.name : directoryName
  const description = typeof metadata.description === 'string' ? metadata.description : ''
  const frontmatter: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (key === 'name' || key === 'description') continue
    if (value === undefined) continue
    frontmatter[key] = value
  }

  return {
    parsed: {
      skillKey,
      description,
      frontmatter,
      // 旧实现取 Mastra 的 instructions（已去掉 frontmatter 的正文）
      body: (result.instructions ?? '').trim(),
      warnings: result.warnings,
    },
    errors: [],
  }
}

/** 单个文件的 sha256 */
export const hashContent = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex')

/** 一个技能全部文件的 sha256（按路径排序后拼接，保证同一份内容得到同一个值） */
export const hashSkillFiles = (files: readonly { path: string; content: string }[]): string => {
  const hash = createHash('sha256')
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
