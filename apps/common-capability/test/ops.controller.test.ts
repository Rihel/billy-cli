import { describe, expect, it, vi } from 'vitest'
import type { Db, RedisStore } from '@repo/kits'
import { OpsController } from '../src/ops.controller.js'

const build = (options: { dbFails?: boolean; redisFails?: boolean } = {}) => {
  const db = {
    dataSource: {
      query: vi.fn(async () => {
        if (options.dbFails) throw new Error('db down')
        return [{ '?column?': 1 }]
      }),
    },
  } as unknown as Db
  const redis = {
    ping: vi.fn(async () => {
      if (options.redisFails) throw new Error('redis down')
      return 'PONG'
    }),
  } as unknown as RedisStore
  return { controller: new OpsController(db, redis), db, redis }
}

describe('OpsController（探针）', () => {
  it('healthz 只证明进程活着，不探依赖', () => {
    const { controller, db, redis } = build()
    const body = controller.healthz()
    expect(body.status).toBe('ok')
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(db.dataSource.query).not.toHaveBeenCalled()
    expect(redis.ping).not.toHaveBeenCalled()
  })

  it('readyz 依赖正常：200 + checks ok', async () => {
    const { controller } = build()
    const status = vi.fn()
    const body = await controller.readyz({ status })
    expect(status).not.toHaveBeenCalled()
    expect(body).toMatchObject({ status: 'ok', checks: { db: 'ok', redis: 'ok' } })
  })

  it('readyz 任一依赖失败：503 + degraded，并写明哪个依赖', async () => {
    const status = vi.fn()
    const { controller } = build({ redisFails: true })
    const body = await controller.readyz({ status })
    expect(status).toHaveBeenCalledWith(503)
    expect(body).toMatchObject({
      status: 'degraded',
      checks: { db: 'ok', redis: 'failed' },
      message: '依赖不可用：Redis',
    })
  })
})
