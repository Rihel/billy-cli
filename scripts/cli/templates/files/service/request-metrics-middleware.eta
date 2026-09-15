import { Inject, Injectable, type NestMiddleware } from '@nestjs/common'
import { Telemetry } from '@repo/kits'
import type { NextFunction, Request, Response } from 'express'

/**
 * 全局请求埋点中间件（由 `RequestMetricsModule` 自注册）：
 * 自动采集 `request.count` / `request.error` / `request.duration`（直方图 → P95/P99），
 * 供指标告警规则（错误率 / 平均耗时 / QPS / 分位）评估。
 *
 * 用中间件而非 Nest 拦截器：拦截器在守卫之后执行，会漏掉 401 / 403 / 429 等被守卫
 * 拒绝的请求，导致 request.count 与真实 QPS 不符。
 */
@Injectable()
export class RequestMetricsMiddleware implements NestMiddleware {
  constructor(@Inject(Telemetry) private readonly telemetry: Telemetry) {}

  use(_request: Request, response: Response, next: NextFunction): void {
    const startedAt = performance.now()

    response.on('finish', () => {
      this.telemetry.incr('request.count')
      this.telemetry.histogram('request.duration', performance.now() - startedAt)
      if (response.statusCode >= 500) {
        this.telemetry.incr('request.error')
      }
    })

    next()
  }
}
