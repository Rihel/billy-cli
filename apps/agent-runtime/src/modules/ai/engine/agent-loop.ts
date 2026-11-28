import type { EngineEvent } from './protocol.js'
import type { ModelClient } from './model-client.js'
import type { TokenUsage } from './types.js'
import type { Toolbox } from '../tools/engine/tools.types.js'

/** Loop 的单步上限与停止原因 */
export interface AgentLoopLimits {
  maxSteps: number
  maxToolCalls?: number
  maxCostUsd?: number
}

/** Loop 的作用域（工具执行需要的会话身份） */
export interface LoopScope {
  conversationId: string
  userId?: string
  isAdmin?: boolean
}

/** Loop 收到的一次启动输入 */
export interface AgentLoopInput {
  conversationId: string
  runId: string
  taskId: string | null
  messages: readonly AgentMessage[]
  model: ModelClient
  /** 本次可执行的工具表（经 ToolFace 授权过滤后） */
  tools?: Toolbox
  /** 工具执行的作用域 */
  scope?: LoopScope
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

/** Loop 的一步（一次模型调用 + 它触发的工具） */
export interface LoopStep {
  index: number
  finishReason: string | null
  usage: TokenUsage | null
}

/** Loop 的最终结果 */
export interface AgentLoopResult {
  status: 'succeeded' | 'failed' | 'canceled' | 'suspended'
  text: string
  reasoning: string
  steps: LoopStep[]
  usage: TokenUsage | null
  /** 上游最后一次 finish 的原因（`stop` / `tool-calls` / `length` …） */
  finishReason: string | null
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
