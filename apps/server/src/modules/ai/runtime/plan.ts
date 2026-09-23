import { TOOL_KEYS } from '../tools/tool-keys.js'

/** 计划载荷（落进时间线的 `plan` 事件，前端据此渲染计划卡片） */
export interface PlanPayload {
  goal: string
  steps: Array<{ id: string; title: string; status: string }>
  summary?: string
}

/**
 * 从工具结果里认出「计划」：只有 `write-plan` 的输出才落 `plan` 事件。
 *
 * 计划为什么走时间线而不是专用表：**只追加、可复盘** ——
 * 「当前计划」= 最后一条 `plan` 事件；「什么时候把哪一步标成完成」= 事件序列。
 * 工具本身是无状态的（全量覆盖语义），运行时只做这一步识别，不引入额外状态。
 */
export const toPlanPayload = (
  toolKey: string | null | undefined,
  output: unknown,
): PlanPayload | null => {
  if (toolKey !== TOOL_KEYS.writePlan) return null
  if (!output || typeof output !== 'object') return null
  const value = output as { goal?: unknown; steps?: unknown; summary?: unknown }
  if (!Array.isArray(value.steps)) return null
  return {
    goal: typeof value.goal === 'string' ? value.goal : '',
    steps: value.steps as PlanPayload['steps'],
    summary: typeof value.summary === 'string' ? value.summary : undefined,
  }
}
