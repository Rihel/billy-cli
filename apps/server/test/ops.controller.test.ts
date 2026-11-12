import type { ConfigService } from '@nestjs/config'
import type { Db, RedisStore } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'
import { describe, expect, it, vi } from 'vitest'
import { BoundaryError } from '../src/common/error/boundary-error.js'
import type { ServerConfig } from '../src/config.js'
import { OpsController } from '../src/modules/ops/index.js'

const serverConfig: ServerConfig = {
  port: 9989,
  authEnabled: true,
  resetPasswordTokenTtlMinutes: 30,
  rateLimitWhitelist: [],
  rateLimitTrustProxy: false,
  keepAliveTimeoutMs: 75_000,
  headersTimeoutMs: 80_000,
  appVersion: 'v9.9.9-test',
}

/** 依赖探活的桩：默认健康，可指定某一项失败 / 永久挂起（模拟依赖假死） */
const makeController = (options: {
  db?: 'ok' | 'failed' | 'hang'
  redis?: 'ok' | 'failed' | 'hang'
  query?: ReturnType<typeof vi.fn>
} = {}) => {
  const dbBehavior = options.db ?? 'ok'
  const redisBehavior = options.redis ?? 'ok'

  const query =
    options.query ??
    vi.fn(async () => {
      if (dbBehavior === 'failed') throw new Error('db down')
      if (dbBehavior === 'hang') return new Promise(() => {})
      return [[], 1]
    })
  const ping =
    redisBehavior === 'failed'
      ? vi.fn(async () => {
          throw new Error('redis down')
        })
      : redisBehavior === 'hang'
        ? vi.fn(() => new Promise(() => {}))
        : vi.fn(async () => 'PONG')

  const db = { dataSource: { query } } as unknown as Db
  const redis = { raw: { ping } } as unknown as RedisStore
  const config = {
    getOrThrow: () => serverConfig,
  } as unknown as ConfigService

  /** 工作区运行时桩：/info 要展示"沙箱可不可用"，但探针测试不关心具体实现 */
  const workspace = {
    status: async () => ({
      mode: 'enforce' as const,
      fileAccessOptions: ['workspace-write', 'read-only'] as const,
      sandbox: {
        available: false,
        reason: { code: 'platform-unsupported' as const, message: '测试环境没有沙箱' },
        probedAt: new Date().toISOString(),
      },
    }),
  }
  return {
    controller: new OpsController(db, redis, config, workspace as never),
    query,
    ping,
  }
}

describe('OpsController /healthz（存活探针）', () => {
  it('不探任何外部依赖：DB / Redis 全挂时依然返回 ok', () => {
    const { controller, query, ping } = makeController({
      db: 'failed',
      redis: 'failed',
    })

    expect(controller.healthz()).toMatchObject({ status: 'ok' })
    // liveness 依赖外部依赖会导致依赖抖动时 k8s 重启全部 pod，这里断言「根本没探」
    expect(query).not.toHaveBeenCalled()
    expect(ping).not.toHaveBeenCalled()
  })

  it('带 uptimeSeconds 与 startedAt，便于人工判断是否刚重启', () => {
    const { controller } = makeController()
    const result = controller.healthz()

    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(Date.parse(result.startedAt))).toBe(false)
  })
})

describe('OpsController /readyz（就绪探针）', () => {
  it('DB / Redis 均可用 → ok，且两者都被探过', async () => {
    const { controller, query, ping } = makeController()

    await expect(controller.readyz()).resolves.toMatchObject({
      status: 'ok',
      checks: { db: 'ok', redis: 'ok' },
    })
    expect(query).toHaveBeenCalledOnce()
    expect(ping).toHaveBeenCalledOnce()
  })

  it('DB 不可用 → 抛 503 边界错误，且 message 指明是数据库', async () => {
    const { controller } = makeController({ db: 'failed' })

    const error = await controller.readyz().catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(BoundaryError)
    expect(error).toMatchObject({
      value: AppErrorCodes.NotReady,
      http: 503,
    })
    expect((error as BoundaryError).message).toContain('数据库')
  })

  it('Redis 不可用 → 同样 503，且两项都探（不因 DB 失败就短路）', async () => {
    const { controller, query, ping } = makeController({ redis: 'failed' })

    const error = await controller.readyz().catch((cause: unknown) => cause)
    expect(error).toMatchObject({ value: AppErrorCodes.NotReady, http: 503 })
    expect((error as BoundaryError).message).toContain('Redis')
    expect(query).toHaveBeenCalledOnce()
    expect(ping).toHaveBeenCalledOnce()
  })

  it('依赖假死（连接不返回）→ 2s 超时后按不可用处理，不挂住请求', async () => {
    vi.useFakeTimers()
    try {
      const { controller } = makeController({ db: 'hang' })
      const assertion = expect(controller.readyz()).rejects.toMatchObject({
        value: AppErrorCodes.NotReady,
        http: 503,
      })

      await vi.advanceTimersByTimeAsync(2_500)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('OpsController /info（运行信息）', () => {
  it('暴露部署版本与已生效的长连接超时（核对滚动更新是否真的换上了新构建）', async () => {
    const { controller } = makeController()

    expect(await controller.info()).toMatchObject({
      name: 'billy-server',
      version: 'v9.9.9-test',
      http: { keepAliveTimeoutMs: 75_000, headersTimeoutMs: 80_000 },
    })
  })
})
