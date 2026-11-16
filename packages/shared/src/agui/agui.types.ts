import type { Event } from '@ag-ui/core'

/** 一个 AG-UI 事件（标准事件与 CUSTOM 的联合） */
export type AgUiEvent = Event

/**
 * 内部片段：AI SDK UI Message Stream 的 chunk 形状。
 *
 * 全仓**不把它收窄成 AI SDK 的联合类型**：一方面 `data-*` 业务块是我们自己造的，
 * 另一方面解码器要能接住历史遗留的任意形状（认不出就原样透传）。
 */
export interface AgUiChunk {
  type?: string
  [key: string]: unknown
}

/** chunk → 事件的上下文 */
export interface AgUiEncodeContext {
  /** 会话 id（`RUN_STARTED.threadId`） */
  threadId: string
  runId: string
  /** 当前 assistant 消息 id（工具事件需要 `parentMessageId`） */
  messageId?: string
}

/** 事件 → chunk 的跨事件状态（工具入参要跨 ARGS 累积） */
export interface AgUiDecodeState {
  toolArgs: Map<string, string>
  toolNames: Map<string, string>
}

export const createAgUiDecodeState = (): AgUiDecodeState => ({
  toolArgs: new Map(),
  toolNames: new Map(),
})
