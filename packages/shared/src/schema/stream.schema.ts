import { z } from 'zod'

/**
 * SSE 事件（服务端 → 客户端推流负载契约，前后端共用）。
 *
 * 对应 SSE 帧的 `event` / `id` / `data` 三字段；`data` 为任意 JSON 负载，
 * 传输层序列化为字符串，客户端反序列化后按 `event` 分发。
 */
export const StreamEventSchema = z.object({
  /** 事件名，如 'task.progress' / 'notification' */
  event: z.string(),
  /** 任意 JSON 负载 */
  data: z.unknown(),
  /** 服务端生成的事件 id（断线续传用；第一版仅透传） */
  id: z.string().optional(),
})
export type StreamEventModel = z.infer<typeof StreamEventSchema>

/**
 * 服务端排空事件名：滚动更新 / 重启时，服务端在关闭长连接前推送的**最后一个**事件。
 *
 * 客户端收到它必须「重连到其他实例」，而不能把流的正常结束当成终态 ——
 * 否则每次滚动更新都会让长连接静默失效（服务端主动 `end()` 属正常结束，
 * 单看协议无法与「不需要重连」区分开）。
 */
export const STREAM_SHUTDOWN_EVENT = 'stream.shutdown'

/**
 * SSE 订阅请求体。
 *
 * 频道命名规范 `<域>:<id>`，如 `user:42` / `admin:all` / `task:42`。
 * 身份频道（`user:*` / `admin:*`）由服务端强制替换为当前登录身份，客户端无需（也不应）指定。
 */
export const StreamSubscribeSchema = z.object({
  channels: z.array(z.string().min(1)).default([]),
})
export type StreamSubscribeDto = z.infer<typeof StreamSubscribeSchema>
