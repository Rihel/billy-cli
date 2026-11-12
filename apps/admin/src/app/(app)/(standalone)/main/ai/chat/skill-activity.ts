import type { UIMessage } from 'ai'

/**
 * 从会话消息里提取**已激活的技能**。
 *
 * "激活"的唯一信号是运行时 `skill` 工具被调用（Mastra 在 agent 层自动挂载，
 * 模型按技能的 description 自己决定调不调）；`skill_read` / `skill_search` 只是读内容，
 * 不单独算激活 —— 否则统计出来的是"翻过哪些技能文件"，不是"用了哪个技能"。
 *
 * 数据从消息 parts 里取，而不是再拉一遍时间线：
 * - 历史消息由 `toUIMessages` 还原成 `dynamic-tool`（带 `toolName` + `input`）；
 * - 实时消息由 AI SDK 产出 `tool-skill`（同样带 `input`）。
 * 两种形状都认，面板因此**随着工具调用实时出现**，不需要轮询。
 */

/** 一个技能在本会话里被激活了几次 */
export interface ActivatedSkill {
  name: string
  calls: number
}

/** 合法技能名（与库里 `skill_key` 的规则一致）：用来过滤历史里把路径当 name 的误调用 */
const SKILL_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** 从 part 里认工具名：历史是 `dynamic-tool` + `toolName`，实时是 `tool-<name>` */
const toolNameOf = (part: UIMessage['parts'][number]): string | null => {
  const record = part as unknown as Record<string, unknown>
  if (typeof record.toolName === 'string' && record.toolName) return record.toolName
  const type = typeof record.type === 'string' ? record.type : ''
  return type.startsWith('tool-') ? type.slice('tool-'.length) : null
}

/** 一条消息 part 若是 `skill` 调用，返回技能名 */
const skillNameOf = (part: UIMessage['parts'][number]): string | null => {
  if (toolNameOf(part) !== 'skill') return null
  const name = asRecord((part as unknown as Record<string, unknown>).input)?.name
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  return SKILL_KEY.test(trimmed) ? trimmed : null
}

/**
 * 按技能名聚合（调用次数降序，同次数按名字排）。
 *
 * 只统计**有入参的调用**：历史里偶有"只有结果行、调用行丢了"的残留，拿不到名字就跳过 ——
 * 不猜、不用 toolCallId 顶替。
 */
export const activatedSkillsOf = (messages: readonly UIMessage[]): ActivatedSkill[] => {
  const counts = new Map<string, number>()
  for (const message of messages) {
    for (const part of message.parts) {
      const name = skillNameOf(part)
      if (!name) continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([name, calls]) => ({ name, calls }))
    .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name))
}
