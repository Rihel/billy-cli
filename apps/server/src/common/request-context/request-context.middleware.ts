import { nanoid } from '@repo/shared'
import type { NextFunction, Request, Response } from 'express'
import { requestContext } from './request-context.js'

/**
 * 请求上下文中间件（Express 层，最先执行）：
 * 生成 requestId、同时写入 `X-Request-Id` 响应头与 `req.id`，并让后续整条链路运行在
 * AsyncLocalStorage 作用域内（守卫写入身份、service 读取身份）。
 *
 * 顺序铁律：必须早于 pino-http 与所有守卫 / 拦截器执行，因此：
 * - 由 `RequestContextModule` 在**模块中间件**中注册（`forRoutes('*')`）；
 * - 该模块在组合根 `imports` 里排在 `LoggerModule` **之前**（Nest 按模块注册顺序挂载中间件）；
 * - 写 `req.id` 是给 pino-http 的 `genReqId` 兜底（kits 默认实现优先读响应头 `X-Request-Id`，
 *   两者因此始终同值，日志 requestId 与排查用的响应头对得上）。
 */
export const requestContextMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  const requestId = nanoid(16)
  response.setHeader('X-Request-Id', requestId)
  ;(request as Request & { id?: string }).id = requestId
  requestContext.run({ requestId, userId: null, adminId: null }, () => next())
}
