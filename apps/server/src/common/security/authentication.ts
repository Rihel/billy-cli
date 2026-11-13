import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import { requestContext } from '../request-context/request-context.js'

/** 读取 cookie（无 cookie-parser 依赖的最小实现，仅取首个同名项并 URL 解码） */
const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) return undefined
  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=')
    if (separator === -1) continue
    if (segment.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(segment.slice(separator + 1).trim())
  }
  return undefined
}

/** 身份体系：前台用户 / 后台管理员 / 不限（任一） */
export type TokenKind = 'user' | 'admin' | 'any'

/**
 * 从 `Authorization: Bearer <token>` 或对应身份体系的 cookie 提取访问令牌。
 *
 * 为什么必须区分身份体系：admin 与 web 的 cookie 名不同（`admin-access-token` /
 * `access-token`），同域部署时会同时存在。`AnyAuthGuard` 依次跑两个守卫时，
 * 每个守卫只能读自己的 cookie；否则「有 user cookie 的 admin 请求」会被当成用户，
 * 管理员身份永远无法通过。
 *
 * `any` 只给「确实不区分身份」的调用方（如登出参数、SSE 订阅）用；守卫不要用它。
 */
export const extractToken = (request: Request, kind: TokenKind = 'any'): string | undefined => {
  const authorization = request.headers.authorization
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7)

  if (kind === 'user') return readCookie(request.headers.cookie, 'access-token')
  if (kind === 'admin') return readCookie(request.headers.cookie, 'admin-access-token')
  return (
    readCookie(request.headers.cookie, 'access-token') ??
    readCookie(request.headers.cookie, 'admin-access-token')
  )
}

/**
 * 参数装饰器：注入当前请求的访问令牌（缺失为 undefined）。
 * 用于登出等「有 token 就撤销、没有也照常返回成功」的幂等接口。
 */
export const AccessToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    extractToken(context.switchToHttp().getRequest<Request>()),
)

/** 取当前登录用户 id（由 UserAuthGuard 写入）；缺失即编程错误 */
export const currentUserId = (): string => {
  const userId = requestContext.get('userId')
  if (!userId) {
    throw new Error('Authenticated request context is unavailable')
  }
  return userId
}

/** 取当前登录管理员 id（由 AdminAuthGuard 写入）；缺失即编程错误 */
export const currentAdminId = (): string => {
  const adminId = requestContext.get('adminId')
  if (!adminId) {
    throw new Error('Authenticated admin request context is unavailable')
  }
  return adminId
}
