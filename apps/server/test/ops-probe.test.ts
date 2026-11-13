import { EventEmitter } from 'node:events'
import { Telemetry } from '@repo/kits'
import { describe, expect, it, vi } from 'vitest'
import { isOpsProbePath } from '../src/common/http/ops-probe.js'
import { RequestLoggerMiddleware } from '../src/common/request-logger/request-logger.middleware.js'
import { RequestMetricsMiddleware } from '../src/common/request-metrics/request-metrics.middleware.js'
import { requestContext } from '../src/common/request-context/index.js'

describe('isOpsProbePath', () => {
  it('命中探针路径（含查询串与结尾斜杠的等价写法）', () => {
    expect(isOpsProbePath('/healthz')).toBe(true)
    expect(isOpsProbePath('/readyz')).toBe(true)
    expect(isOpsProbePath('/readyz?verbose=1')).toBe(true)
    expect(isOpsProbePath('/healthz/')).toBe(true)
  })

  it('不误伤业务路径（含前缀相同的路径）', () => {
    expect(isOpsProbePath('/readyzz')).toBe(false)
    expect(isOpsProbePath('/info')).toBe(false)
    expect(isOpsProbePath('/user/page-query')).toBe(false)
    expect(isOpsProbePath(undefined)).toBe(false)
  })
})

const makeResponse = (statusCode: number) => {
  const res = new EventEmitter() as EventEmitter & { statusCode: number }
  res.statusCode = statusCode
  return res
}

/** 记录日志调用次数的桩 logger（中间件只关心「有没有记」） */
const makeLogger = () => {
  const calls: unknown[][] = []
  const record = (...args: unknown[]) => calls.push(args)
  const logger = {
    setContext: () => {},
    debug: record,
    log: record,
    info: record,
    warn: record,
    error: record,
  }
  return { logger: logger as never, calls }
}

const runLogger = (path: string) => {
  const { logger, calls } = makeLogger()
  const middleware = new RequestLoggerMiddleware(logger)
  const res = makeResponse(200)
  const next = vi.fn()

  requestContext.run({ requestId: 'rid-test', userId: null, adminId: null }, () => {
    middleware.use({ method: 'GET', path, originalUrl: path } as never, res as never, next)
    res.emit('finish')
  })

  return { calls, next }
}

describe('运维探针不进请求日志', () => {
  it('/healthz、/readyz 不记日志（避免每 3s 一条刷屏）', () => {
    for (const path of ['/healthz', '/readyz']) {
      const { calls, next } = runLogger(path)
      expect(next).toHaveBeenCalledOnce()
      expect(calls).toHaveLength(0)
    }
  })

  it('业务路径照常记录一条', () => {
    expect(runLogger('/user/create').calls).toHaveLength(1)
  })
})

describe('运维探针不进请求指标', () => {
  it('/healthz 不埋点（避免虚高 QPS / 错误率污染指标告警）', () => {
    const telemetry = new Telemetry()
    const incr = vi.spyOn(telemetry, 'incr')
    const histogram = vi.spyOn(telemetry, 'histogram')
    const middleware = new RequestMetricsMiddleware(telemetry)
    const res = makeResponse(200)

    middleware.use({ method: 'GET', path: '/healthz' } as never, res as never, vi.fn())
    res.emit('finish')

    expect(incr).not.toHaveBeenCalled()
    expect(histogram).not.toHaveBeenCalled()
  })

  it('业务路径照常埋点，且 5xx 计入 request.error', () => {
    const telemetry = new Telemetry()
    const incr = vi.spyOn(telemetry, 'incr')
    const middleware = new RequestMetricsMiddleware(telemetry)
    const res = makeResponse(500)

    middleware.use({ method: 'POST', path: '/user/create' } as never, res as never, vi.fn())
    res.emit('finish')

    expect(incr).toHaveBeenCalledWith('request.count')
    expect(incr).toHaveBeenCalledWith('request.error')
  })
})
