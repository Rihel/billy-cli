import { nanoid } from '@repo/shared'
import type { NextFunction, Request, Response } from 'express'
import { requestContext } from './request-context.js'

/**
 * 请求上下文中间件（Express 层，最先执行）：
 * 生成 requestId、同时写入 `X-Request-Id` 响应头与 `req.id`，并让后续整条链路运行在
 * AsyncLocalStorage 作用域内（守卫写入身份、service 读取身份）。
 *
 * 顺序铁律：必须早于请求日志 / 请求指标与所有守卫、拦截器执行，因此：
 * - 由 `RequestContextModule` 在**模块中间件**中注册（`forRoutes('*')`）；
 * - 该模块在组合根 `imports` 里排在 `RequestLoggerModule` / `RequestMetricsModule` **之前**
 *   （Nest 按模块注册顺序挂载中间件）。
 *
 * 写 `req.id` 与响应头同值：请求日志（`RequestLoggerMiddleware`）从 ALS 取 requestId 记录，
 * 而排查时拿到的是响应头，两者必须对得上。
 */
export const requestContextMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  const requestId = nanoid(16)
  response.setHeader('X-Request-Id', requestId)
  ;(request as Request & { id?: string }).id = requestId

  // 客户端 IP / UA：登录时写进会话元数据（登录设备列表展示用）。
  // 取不到就存 null —— 设备列表要能显示「未知」，不能因为缺字段就报错。
  const ip = request.ip ?? request.socket?.remoteAddress ?? null
  const userAgent = request.headers['user-agent'] ?? null

  requestContext.run({ requestId, userId: null, adminId: null, ip, userAgent }, () => next())
}
