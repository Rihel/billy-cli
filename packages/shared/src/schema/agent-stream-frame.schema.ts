import { z } from 'zod'

/**
 * agent-runtime → main 的运行片段（经 Redis pub/sub，频道见 `agentStreamChannel`）。
 *
 * 为什么不再是 Kafka 事件：这条链路只需要「把某一轮的输出送到持有那条 SSE 连接的那个
 * main 实例」，不需要积压、回放或多消费方 —— 补发靠 runtime 的 Redis 输出记录按 rev 读，
 * 所以 Kafka 的持久化在这里是纯成本（2026-11-15 实测：18 小时写出 1,536,196 条 / 686MB）。
 *
 * 频道名已经携带 `clientId`（收件地址），帧里因此不再重复它：
 * 一条 400 字节的消息里有 233 字节是信封，省掉一份归属字段就少一份固定开销。
 */
export const AGENT_STREAM_FRAME_VERSION = 2

/** 频道前缀：一个前端 SSE 连接一个频道（`clientId` 由 main 在 attach 时生成） */
export const AGENT_STREAM_CHANNEL_PREFIX = 'agent:stream:client:'

/** 前端连接 → 帧频道名 */
export const agentStreamChannel = (clientId: string): string =>
  `${AGENT_STREAM_CHANNEL_PREFIX}${clientId}`

/**
 * 一帧运行输出：
 * - `event` 就是一个 AG-UI 事件（版本 1 时叫 `chunk`，装的是 AI SDK 的原始片段）；
 * - `final` 表示这一轮已结束，main 直接 `end()`（**不写 `[DONE]`**）；
 * - `runId` 只用于排障与日志（频道负责投递，不看这个字段）。
 *
 * 版本号 1 → 2 的语义变化是「载荷从 chunk 改为事件」，同时挡住新旧进程互串：
 * 旧网关解析不了 `event` 字段会丢帧，而不是把事件当 chunk 写出去造成错乱。
 */
export const AgentStreamFrameSchema = z.object({
  version: z.literal(AGENT_STREAM_FRAME_VERSION),
  runId: z.string().min(1),
  event: z.unknown(),
  final: z.boolean().default(false),
  createdAt: z.string(),
})
export type AgentStreamFrameModel = z.infer<typeof AgentStreamFrameSchema>
