import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { AppLogger } from '@repo/kits'
import { requestContext } from '../src/common/request-context/index.js'
import { RequestLoggerMiddleware } from '../src/common/request-logger/request-logger.middleware.js'

interface Call {
  level: string
  message?: string
  data: Record<string, unknown>
}

const makeLogger = () => {
  const calls: Call[] = []
  const setContext = vi.fn()
  const record = (level: string) => (message?: string, data?: unknown) => {
    calls.push({ level, message, data: (data ?? {}) as Record<string, unknown> })
  }
  const logger = {
    setContext,
    log: record('info'),
    info: record('info'),
    warn: record('warn'),
    debug: record('debug'),
    error: record('error'),
  } as unknown as AppLogger
  return { logger, calls, setContext }
}

const makeResponse = (statusCode: number) => {
  const res = new EventEmitter() as EventEmitter & { statusCode: number }
  res.statusCode = statusCode
  return res
}

const request = { method: 'POST', originalUrl: '/todo/create?x=1' }

/** 在请求上下文（ALS）里跑一次「请求 → 响应结束」，模拟真实链路 */
const runRequest = (
  middleware: RequestLoggerMiddleware,
  statusCode: number,
  finish: 'finish' | 'close' = 'finish',
  store = { requestId: 'rid-1', userId: 'u-1', adminId: null as string | null },
) => {
  const res = makeResponse(statusCode)
  const next = vi.fn()
  requestContext.run(store, () => {
    middleware.use(request as never, res as never, next)
    // 真实场景里 finish 由 Express 在 ALS 上下文内触发
    res.emit(finish)
  })
  return { res, next }
}

describe('RequestLoggerMiddleware（替代 pino-http 的请求日志）', () => {
  it('构造时把 context 收敛为 HTTP', () => {
    const { logger, setContext } = makeLogger()
    new RequestLoggerMiddleware(logger)
    expect(setContext).toHaveBeenCalledWith('HTTP')
  })

  it('200 → info，含 method/url/status/durationMs 与请求上下文里的身份', () => {
    const { logger, calls } = makeLogger()
    const { next } = runRequest(new RequestLoggerMiddleware(logger), 200)

    expect(next).toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    expect(calls[0].level).toBe('info')
    expect(calls[0].data).toMatchObject({
      method: 'POST',
      url: '/todo/create?x=1',
      status: 200,
      requestId: 'rid-1',
      userId: 'u-1',
      adminId: null,
    })
    expect(typeof calls[0].data.durationMs).toBe('number')
    expect(calls[0].message).toContain('POST /todo/create?x=1 200')
  })

  it('按状态码分级：4xx → warn，5xx → error', () => {
    const warn = makeLogger()
    runRequest(new RequestLoggerMiddleware(warn.logger), 404)
    expect(warn.calls[0].level).toBe('warn')

    const err = makeLogger()
    runRequest(new RequestLoggerMiddleware(err.logger), 503)
    expect(err.calls[0].level).toBe('error')
  })

  it('未登录时身份为 null', () => {
    const { logger, calls } = makeLogger()
    runRequest(new RequestLoggerMiddleware(logger), 200, 'finish', {
      requestId: 'rid-2',
      userId: null,
      adminId: null,
    })
    expect(calls[0].data).toMatchObject({ userId: null, adminId: null })
  })

  it('客户端提前断开（close 且未 finish）也记一条', () => {
    const { logger, calls } = makeLogger()
    runRequest(new RequestLoggerMiddleware(logger), 200, 'close')
    expect(calls).toHaveLength(1)
  })

  it('finish 与 close 都触发时只记一条（不重复）', () => {
    const { logger, calls } = makeLogger()
    const middleware = new RequestLoggerMiddleware(logger)
    const res = makeResponse(200)

    requestContext.run({ requestId: 'rid-3', userId: null, adminId: null }, () => {
      middleware.use(request as never, res as never, vi.fn())
      res.emit('finish')
      res.emit('close')
    })

    expect(calls).toHaveLength(1)
  })
})
