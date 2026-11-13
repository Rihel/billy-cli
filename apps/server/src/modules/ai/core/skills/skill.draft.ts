import { createHash } from 'node:crypto'
import { dump } from 'js-yaml'
import { validateSkillFileContent } from './skill.content.js'
import { SKILL_FILE } from './skill.paths.js'

/**
 * 技能草稿：把「元信息 + 正文」拼成 `SKILL.md`，并用 Mastra 的规则校验。
 *
 * 为什么借 Mastra 的 `validateSkillContent` 而不是自己写一套：
 * 技能最终由它加载，校验口径必须**与真正加载时一致**（name 与目录名一致、description ≤1024、
 * frontmatter 能被解析）。自己写一套只会得到"我们这边过了、它那边跳过"的分裂。
 */

/** 一个技能草稿（页面 / 工具 / 导入都归一到这个形状） */
export interface SkillDraft {
  /** 技能名（= 目录名） */
  skillKey: string
  /** frontmatter 的 description：什么时候用 */
  description: string
  /** 其余 frontmatter 键（name / description 由入参决定，这里给了也会被覆盖） */
  frontmatter: Record<string, unknown>
  /** Markdown 正文（不含 frontmatter） */
  body: string
}

/** 草稿校验结果（errors 非空 = 不能保存） */
export interface SkillDraftValidation {
  /** 拼好的 SKILL.md 全文（校验通过时可以直接落库） */
  content: string
  valid: boolean
  errors: string[]
  warnings: string[]
  /** 解析出来的完整 frontmatter（含 name / description） */
  metadata: Record<string, unknown>
}

/**
 * 把草稿拼成 `SKILL.md`。
 *
 * `name` / `description` **始终以入参为准**：frontmatter 里的同名字段被覆盖，
 * 避免"页面显示的是 A、文件里写的是 B"。
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

/** 校验草稿（不抛错：把 Mastra 的错误 / 警告原样带回去，由调用方决定怎么处置） */
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

/** 从一份完整的 `SKILL.md` 里拆出「元信息 + 正文」（导入用） */
export interface ParsedSkillMarkdown {
  skillKey: string
  description: string
  frontmatter: Record<string, unknown>
  body: string
  warnings: string[]
}

/**
 * 解析并校验一份 `SKILL.md`（导入外部目录时用）。
 *
 * 返回 `null` 表示不合法；`errors` 由调用方翻译成"这个技能为什么没导入"。
 * 校验通过时，`metadata` 里除 name / description 之外的键都进 `frontmatter`。
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
      body: (result.instructions ?? '').trim(),
      warnings: result.warnings,
    },
    errors: [],
  }
}

/** UTF-8 字节数（落库与限额都用它，别拿 `String.length` 当字节数） */
export const byteLength = (content: string): number => Buffer.byteLength(content, 'utf8')

/** 单个文件的 sha256 */
export const hashContent = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex')

/** 一个技能全部文件的 sha256（按路径排序后拼接，保证同一份内容得到同一个值） */
export const hashSkillFiles = (files: readonly { path: string; content: string }[]): string => {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** 技能入口文件的固定路径 */
export const SKILL_ENTRY_PATH = SKILL_FILE
