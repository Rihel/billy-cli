import { EventType, PROTOCOL_VERSION } from '@ag-ui/core'

/**
 * AG-UI 协议常量与业务扩展名单。
 *
 * 这里**只**做两件事：
 * 1. 把 `@ag-ui/core` 的协议枚举 / 版本号收成一个入口（全仓只从 `@repo/shared` 拿，
 *    其它包不重复声明 `@ag-ui/core`，避免版本漂移）；
 * 2. 把标准事件表达不了的业务过程集中成 `AGUI_CUSTOM` 一张名单 —— 换前缀即可整体搬走。
 *
 * 注意：同一文件里既要导出又要使用 `EventType` 时，必须**先 import 再 export**。
 * 直接 `export { X } from '@ag-ui/core'` 不建立本地绑定，编译能过、运行时会报
 * `X is not defined`（手册 §3.2 踩过）。
 */
export { EventType as AgUiEventType, PROTOCOL_VERSION as AGUI_PROTOCOL_VERSION }

/** 业务扩展事件名（统一 `agent.` 前缀；前端与后端都从这里取，不写字面量） */
export const AGUI_CUSTOM = {
  message: 'agent.message',
  plan: 'agent.plan',
  subAgent: 'agent.sub-agent',
  toolEvent: 'agent.tool-event',
  queue: 'agent.queue',
  usage: 'agent.usage',
  title: 'agent.title',
  suspended: 'agent.suspended',
  runSuspended: 'agent.run-suspended',
  status: 'agent.status',
  summary: 'agent.summary',
} as const

export type AgUiCustomName = (typeof AGUI_CUSTOM)[keyof typeof AGUI_CUSTOM]

/** 全部标准事件名（形态判别用：旧记录是 chunk，两种形态会在 TTL 内共存） */
export const AGUI_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(EventType).map((value) => String(value)),
)

/** 「这一轮结束」的三种形态：AG-UI 事件 / 解码后的 finish / 旧记录里的结束标记 */
export const AGUI_FINAL_CHUNK_TYPES: ReadonlySet<string> = new Set(['finish', '__run_end__'])
