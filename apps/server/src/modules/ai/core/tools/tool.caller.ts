import type { AgentRuntimeEnvelope } from '../envelope.js'
import type { ToolCaller } from './tools.types.js'

/**
 * 运行时信封 → 工具调用方（设计 §5.7）。
 *
 * 纯映射，单独一个文件：作用域判定、限流主体、审计字段都读它的结果。
 * 没有信封时返回 `null`（由 `scope` 插件给 forbidden 结论，**不伪造身份**）。
 */
export const toCaller = (envelope: AgentRuntimeEnvelope | null): ToolCaller | null => {
  if (!envelope) return null
  return {
    conversationId: envelope.conversationId,
    runId: envelope.parentRunId,
    userId: envelope.triggeredBy,
    isAdmin: envelope.isAdmin,
    agentKey: envelope.agentKey,
    // 作用域按**根 agent** 判：子 agent 沿用父的判定
    rootAgentKey: envelope.rootAgentKey,
    depth: envelope.depth,
  }
}
