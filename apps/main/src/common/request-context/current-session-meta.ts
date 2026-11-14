import type { SessionMeta } from '@repo/kits'
import { requestContext } from './request-context.js'

/**
 * 当前请求的会话元数据（IP / User-Agent），登录时写进 Redis 会话记录，
 * 供「登录设备列表」展示。
 *
 * 为什么从 ALS 取：`RequestContextMiddleware` 已经在**最早**的中间件里写好了这两个值
 * （那时才有原始请求），登录发生在 controller → service 深处，重新透传 Request 参数
 * 只会污染方法签名，与 `requestId` / 身份走 ALS 是同一套思路。
 */
export const currentSessionMeta = (): SessionMeta => ({
  ip: requestContext.get('ip') ?? null,
  userAgent: requestContext.get('userAgent') ?? null,
})
