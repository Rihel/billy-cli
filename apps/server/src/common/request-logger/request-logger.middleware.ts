import { Inject, Injectable, type NestMiddleware } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import type { NextFunction, Request, Response } from 'express'
import { requestContext } from '../request-context/index.js'

/**
 * 全局请求日志中间件（由 `RequestLoggerModule` 自注册）——替代原先 pino-http 的自动记录。
 *
 * 为什么自己写：去掉 nestjs-pino 后没有现成的请求日志，而请求日志要带**登录身份**，
 * 身份只存在于请求上下文 ALS 里，所以由 app 侧（能直接读 `requestContext`）实现最自然。
 *
 * 记录字段与原来保持一致：method / url / status / durationMs / requestId / userId / adminId，
 * 按状态码分级（<400 info、4xx warn、5xx error）。
 *
 * 用中间件而非拦截器：拦截器在守卫之后执行，会漏掉被守卫拒绝的 401 / 403 / 429，
 * 这些恰恰是排障最需要的（与 `RequestMetricsMiddleware` 同一理由）。
 *
 * 顺序：必须排在 `RequestContextModule` 之后（它写 ALS），见 `root.module.ts` 的 imports 顺序。
 */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  constructor(@Inject(AppLogger) private readonly logger: AppLogger) {
    // 收敛 context：否则每行请求日志都带 [RequestLoggerMiddleware]，噪音大且不便于 grep
    this.logger.setContext('HTTP')
  }

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = performance.now()
    // finish 与 close 可能都触发（正常响应也会 close），只记一条
    let logged = false

    const write = (): void => {
      if (logged) return
      logged = true

      const durationMs = Math.round(performance.now() - startedAt)
      const status = response.statusCode
      const url = request.originalUrl ?? request.url
      const data = {
        method: request.method,
        url,
        status,
        durationMs,
        requestId: requestContext.get('requestId') ?? null,
        userId: requestContext.get('userId') ?? null,
        adminId: requestContext.get('adminId') ?? null,
      }
      const message = `${request.method} ${url} ${status} ${durationMs}ms`

      if (status >= 500) this.logger.error(message, data)
      else if (status >= 400) this.logger.warn(message, data)
      else this.logger.info(message, data)
    }

    response.on('finish', write)
    // 客户端提前断开（未 finish）也要留痕，否则这类请求在日志里完全消失
    response.on('close', write)

    next()
  }
}
