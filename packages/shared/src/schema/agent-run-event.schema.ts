import { z } from 'zod'

/** AI 会话运行事件 topic（逻辑名；实际 topic 由 KAFKA_TOPIC_PREFIX 加前缀） */
export const AGENT_RUN_EVENT_TOPIC = 'agent.run.events'

/** 事件协议版本：加字段走兼容扩展，删改字段必须升版本 */
export const AGENT_RUN_EVENT_VERSION = 1

/**
 * agent-runtime → main 的运行事件。
 *
 * - `chunk` 就是 AI SDK UI Message Stream 的原始 chunk，main 原样写成 SSE `data:`；
 * - `clientId` 是 main 为一次前端连接生成的随机串，main 只把事件推给对应连接；
 * - `runId` / `conversationId` / `ownerId` 用于归属校验与排障；
 * - `final` 表示这一轮已结束，main 写 `[DONE]` 并关闭 SSE。
 */
export const AgentRunEventSchema = z.object({
  version: z.literal(AGENT_RUN_EVENT_VERSION),
  clientId: z.string().min(1),
  runId: z.string().min(1),
  conversationId: z.string().min(1),
  ownerId: z.string().min(1),
  chunk: z.unknown(),
  final: z.boolean().default(false),
  createdAt: z.string(),
})
export type AgentRunEventModel = z.infer<typeof AgentRunEventSchema>
