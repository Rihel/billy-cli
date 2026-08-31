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
export type StreamEvent = z.infer<typeof StreamEventSchema>

/**
 * SSE 订阅请求体。
 *
 * 频道命名规范 `<域>:<id>`，如 `user:42` / `admin:all` / `task:42`。
 * 身份频道（`user:*` / `admin:*`）由服务端强制替换为当前登录身份，客户端无需（也不应）指定。
 */
export const StreamSubscribeSchema = z.object({
  channels: z.array(z.string().min(1)).default([]),
})
export type StreamSubscribeInput = z.infer<typeof StreamSubscribeSchema>
