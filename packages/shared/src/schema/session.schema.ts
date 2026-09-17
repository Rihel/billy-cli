import { z } from 'zod'

/**
 * 登录设备（会话）条目。
 *
 * 不含任何 token 派生值：`sessionId` 是服务端随机生成、仅用于「下线某台设备」的标识，
 * 即便泄露也无法用于认证。
 */
export const SessionEntrySchema = z.object({
  /** 会话标识（下线某台设备时传给 /session/remove） */
  sessionId: z.string(),
  /** 登录时间（epoch ms） */
  createdAt: z.number(),
  /** 最后活跃时间（epoch ms；服务端按 60s 节流写回，精度为分钟级） */
  lastSeenAt: z.number(),
  /** 登录来源 IP（取不到为 null） */
  ip: z.string().nullable(),
  /** 登录来源 User-Agent（取不到为 null；前端用 parseUserAgent 解析展示） */
  userAgent: z.string().nullable(),
  /** 是否为当前请求所用会话（前端据此禁止「下线自己」并显示「本机」） */
  current: z.boolean(),
})
export type SessionEntryModel = z.infer<typeof SessionEntrySchema>

export const SessionListSchema = z.object({
  items: z.array(SessionEntrySchema),
  /** 当前会话 id（与 items 里 current=true 的条目一致；无则为 null） */
  currentSessionId: z.string().nullable(),
})
export type SessionListModel = z.infer<typeof SessionListSchema>

export const RemoveSessionSchema = z.object({
  sessionId: z.string().min(1),
})
export type RemoveSessionDto = z.infer<typeof RemoveSessionSchema>
