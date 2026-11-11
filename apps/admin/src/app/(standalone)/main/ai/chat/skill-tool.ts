import { getToolName } from 'ai'
import type { ToolPart } from '@repo/ui/components/ai-elements/tool.tsx'

/**
 * 从工具调用里识别"**AI 生成 / 导入技能**"的动作，并整理成可展示的形状。
 *
 * 两个工具：
 * - `skill-save`：新建或更新技能。入参里**已经带着正文与文件**，所以还没落库时也能先预览；
 * - `skill-import`：从链接导入。正文不在入参里，只能等结果出来再按技能名去库里读。
 *
 * 返回 `null` 表示"不是技能写入类工具"（`skill-list` / `skill-delete` / `skill-enable` 不在此列）。
 */

/** 导入结果里的一条 */
export interface SkillWriteEntry {
  skillKey: string
  /** 结果状态（导入有 created/updated/skipped/failed；新建/更新由 `created` 推出来） */
  status?: string
}

/** `skill-save` 的入参就是一份可直接预览的草稿 */
export interface SkillWriteDraft {
  description?: string
  body: string
  files: { path: string; content: string }[]
}

export interface SkillWriteInfo {
  tool: 'skill-save' | 'skill-import'
  entries: SkillWriteEntry[]
  /** 仅 `skill-save`：入参里的正文 / 文件（API 还没读到时用它兜底预览） */
  draft?: SkillWriteDraft
  /** 可读来源：导入链接 / 导入来源标签 */
  source?: string
  /** 写入是否已经有结果（流式中还没回结果时用于文案） */
  finished: boolean
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

const asFiles = (value: unknown): { path: string; content: string }[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const record = asRecord(item)
    const path = asString(record?.path)
    const content = typeof record?.content === 'string' ? record.content : undefined
    return path && content !== undefined ? [{ path, content }] : []
  })
}

export const skillWriteOf = (part: ToolPart): SkillWriteInfo | null => {
  const tool = getToolName(part)
  if (tool !== 'skill-save' && tool !== 'skill-import') return null

  const input = asRecord(part.input)
  const output = asRecord(part.output)
  const finished = part.state === 'output-available' || part.state === 'output-error'

  if (tool === 'skill-save') {
    const skillKey = asString(input?.skillKey)
    if (!skillKey) return null
    const created = output?.created
    return {
      tool,
      entries: [
        {
          skillKey,
          ...(typeof created === 'boolean' ? { status: created ? 'created' : 'updated' } : {}),
        },
      ],
      draft: {
        ...(asString(input?.description) ? { description: asString(input?.description) } : {}),
        body: typeof input?.body === 'string' ? input.body : '',
        files: asFiles(input?.files),
      },
      finished,
    }
  }

  const items = Array.isArray(output?.items) ? output.items : []
  const entries = items.flatMap((item) => {
    const record = asRecord(item)
    const skillKey = asString(record?.skillKey)
    if (!skillKey) return []
    const status = asString(record?.status)
    return [{ skillKey, ...(status ? { status } : {}) }]
  })
  return {
    tool,
    entries,
    source: asString(output?.source) ?? asString(input?.url),
    finished,
  }
}

/** 导入结果状态 → 人读文案 */
export const skillWriteStatusText = (status: string | undefined): string | undefined => {
  switch (status) {
    case 'created':
      return '新建'
    case 'updated':
      return '覆盖'
    case 'skipped':
      return '已存在'
    case 'failed':
      return '失败'
    default:
      return undefined
  }
}
