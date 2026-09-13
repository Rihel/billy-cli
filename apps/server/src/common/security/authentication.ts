import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import { requestContext } from '../request-context/request-context.js'

/** 读取 cookie（无 cookie-parser 依赖的最小实现，仅取首个同名项并 URL 解码） */
const readCookie = (
  header: string | undefined,
  name: string,
): string | undefined => {
  if (!header) return undefined
  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=')
    if (separator === -1) continue
    if (segment.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(segment.slice(separator + 1).trim())
  }
  return undefined
}

/** 从 `Authorization: Bearer <token>` 或 `access-token` cookie 提取访问令牌 */
export const extractToken = (request: Request): string | undefined => {
  const authorization = request.headers.authorization
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7)
  return readCookie(request.headers.cookie, 'access-token')
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
