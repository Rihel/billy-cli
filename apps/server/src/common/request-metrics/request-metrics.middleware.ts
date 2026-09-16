import { Inject, Injectable, type NestMiddleware } from '@nestjs/common'
import { Telemetry } from '@repo/kits'
import type { NextFunction, Request, Response } from 'express'
import { isOpsProbePath } from '../http/ops-probe.js'

/**
 * 全局请求埋点中间件（由 `RequestMetricsModule` 自注册）：
 * 自动采集 `request.count` / `request.error` / `request.duration`（直方图 → P95/P99），
 * 供指标告警规则（错误率 / 平均耗时 / QPS / 分位）评估。
 *
 * 用中间件而非 Nest 拦截器：拦截器在守卫之后执行，会漏掉 401 / 403 / 429 等被守卫
 * 拒绝的请求，导致 request.count 与真实 QPS 不符。
 *
 * 运维探针不埋点：否则探针的 200 会虚高 QPS、探针自身的 503 会虚高错误率 ——
 * 而错误率正是指标告警的输入，会触发与真实业务故障无关的告警。
 */
@Injectable()
export class RequestMetricsMiddleware implements NestMiddleware {
  constructor(@Inject(Telemetry) private readonly telemetry: Telemetry) {}

  use(request: Request, response: Response, next: NextFunction): void {
    if (isOpsProbePath(request.path)) {
      next()
      return
    }

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
