import type { EngineEvent } from './protocol.js'
import type { ModelClient } from './model-client.js'
import type { TokenUsage } from './types.js'

/** Loop 的单步上限与停止原因 */
export interface AgentLoopLimits {
  maxSteps: number
  maxToolCalls?: number
  maxCostUsd?: number
}

/** Loop 收到的一次启动输入 */
export interface AgentLoopInput {
  conversationId: string
  runId: string
  taskId: string | null
  messages: readonly AgentMessage[]
  model: ModelClient
  limits: AgentLoopLimits
  signal: AbortSignal
}

/** Loop 收到的一次续跑输入 */
export interface AgentLoopResumeInput extends Omit<AgentLoopInput, 'messages'> {
  resumeData?: unknown
}

/** Loop 侧的消息 */
export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  name?: string
}

/** Loop 的结束原因：Host / Recorder / 看门狗统一用它判断 */
export type LoopStopReason =
  | 'done'
  | 'error'
  | 'interrupted'
  | 'suspended'
  | 'max_steps'
  | 'cost_limit'
  | 'no_next_context'

/** Loop 的最终结果 */
export interface AgentLoopResult {
  status: 'succeeded' | 'failed' | 'canceled' | 'suspended'
  text: string
  reasoning: string
  usage: TokenUsage | null
  stopReason: LoopStopReason
  error?: { code: string; message: string }
  suspend?: unknown
}

/** 一次进行中的 loop */
export interface AgentLoopRun {
  events: AsyncIterable<EngineEvent>
  result: Promise<AgentLoopResult>
  abort(reason?: string): void
}

/**
 * 引擎接缝：S1 保留现有循环行为，只收窄接口；后续可替换成薄 loop / 厚 loop。
 *
 * 持久化、队列、HTTP 都不在 loop 内。
 */
export interface AgentLoop {
  start(input: AgentLoopInput): Promise<AgentLoopRun>
  resume(input: AgentLoopResumeInput): Promise<AgentLoopRun>
}
