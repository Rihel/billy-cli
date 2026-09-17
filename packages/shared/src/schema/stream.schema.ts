import { z } from 'zod'
import { AlertChannelSchema } from './monitor.schema'

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
 * 管理员广播频道：管理员端连接在身份频道之外**额外自动订阅**的频道。
 *
 * 用途是「面向全体管理员的实时通知」（当前为告警触发）。注意客户端**不能**自行请求
 * `admin:*` / `user:*` 频道（防窃听他人身份频道，见 `StreamSubscribeSchema` 说明），
 * 广播频道只能由服务端按当前身份域注入 —— 故它是协议的一部分，放在 shared 而非散落各处。
 */
export const STREAM_ADMIN_BROADCAST_CHANNEL = 'admin:all'

/**
 * 告警触发事件名（发布到 `STREAM_ADMIN_BROADCAST_CHANNEL`）。
 *
 * 与告警日志的差别：日志是「查历史」（分页拉取），本事件是「实时到」（推送）。
 */
export const STREAM_ALERT_FIRED_EVENT = 'alert.fired'

/**
 * 告警触发推送负载（SSE `alert.fired`）。
 *
 * 刻意**不复用告警日志实体**：实体字段与时间戳由 ORM 决定，跨端契约必须稳定，
 * 故显式声明展示所需字段，前后端共用同一份 schema 解析。
 */
export const AlertFiredEventSchema = z.object({
  /** 命中的规则 id；测试告警（无规则）为 null */
  ruleId: z.string().nullable(),
  /** 规则名；测试告警为「测试告警」 */
  ruleName: z.string(),
  /** 告警标题 */
  title: z.string(),
  /** 完整告警正文（含请求路径 / RequestId 等上下文） */
  message: z.string(),
  /** 本次发送通道 */
  channel: AlertChannelSchema,
  /** 通道发送结果 */
  status: z.enum(['success', 'failed']),
  /** 失败原因（成功为 null） */
  error: z.string().nullable(),
  /** 发送时间（ISO 8601） */
  sentAt: z.string(),
})
export type AlertFiredEventModel = z.infer<typeof AlertFiredEventSchema>

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
