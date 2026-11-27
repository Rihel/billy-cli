import type { TokenUsage } from './types.js'

/**
 * Loop 看到的模型客户端。
 *
 * 为什么单独定义：Loop 不应该拿 Mastra 实例或供应商 SDK 的实例；换模型 / 换网关时
 * 只替换这个接口的实现，不动 loop。
 */
export interface ModelClient {
  /** 展示与日志用：`<provider>/<model>` */
  readonly ref: string
  /** 上下文窗口；未知时 null */
  readonly contextWindow: number | null
  /** 流式调用 */
  stream(input: ModelCallInput): AsyncIterable<ModelEvent>
}

/** 一次模型调用的输入 */
export interface ModelCallInput {
  messages: readonly ModelMessage[]
  tools?: readonly ModelToolSpec[]
  signal?: AbortSignal
  maxOutputTokens?: number
}

/** Loop 侧的模型消息（不带供应商专有字段） */
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  name?: string
}

/** Loop 侧的工具声明 */
export interface ModelToolSpec {
  name: string
  description: string
  inputSchema: unknown
}

/** 模型流事件 */
export type ModelEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: string }
