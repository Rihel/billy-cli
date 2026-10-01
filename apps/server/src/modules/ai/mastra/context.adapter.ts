import { RequestContext } from '@mastra/core/request-context'
import { AGENT_RUNTIME_KEY, type AgentRuntimeEnvelope } from '../core/ai.core.types.js'

/**
 * **运行时信封 ↔ Mastra `RequestContext`** 的读写（适配器，设计 §5.8）。
 *
 * 这是"信封"这个概念的**唯一** Mastra 触点：主体（core / tools / runtime 的业务部分）只认
 * `AgentRuntimeEnvelope`，不 import `@mastra/*`。
 *
 * 用 `setRaw` / `getRaw`（运行时键，不进 schema 校验，见 Mastra 的 `RequestContext` 注释）。
 */

/** 读信封。`null` = 这次调用没走我们的编排层（装配 / 配置错误），调用方必须显式处理 */
export const readEnvelope = (
  requestContext: RequestContext | undefined,
): AgentRuntimeEnvelope | null => {
  if (!requestContext) return null
  const value = requestContext.getRaw(AGENT_RUNTIME_KEY)
  return (value as AgentRuntimeEnvelope | undefined) ?? null
}

/** 写信封（编排层与子 agent 都用它） */
export const toRequestContext = (envelope: AgentRuntimeEnvelope): RequestContext => {
  const requestContext = new RequestContext()
  requestContext.setRaw(AGENT_RUNTIME_KEY, envelope)
  return requestContext
}
