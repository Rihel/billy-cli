import { Controller, Get, HttpCode, Inject, Res, UseFilters } from '@nestjs/common'
import { AppExceptionFilter, Db, RedisStore } from '@repo/kits'

/**
 * 运维探针（**根路径，唯一允许 GET 的地方**；业务路由仍是 POST + body）。
 *
 * - `GET /healthz`（liveness）：只证明进程活着，不探外部依赖 —— liveness 依赖 DB / Redis 会让
 *   一次依赖抖动把所有副本一起重启，重启也解决不了依赖故障；
 * - `GET /readyz`（readiness）：探 DB 与 Redis，任一不可用即 **HTTP 503** 主动摘流
 *   （k8s 只把 2xx / 3xx 当就绪）。
 */

/** 单次依赖探活超时：依赖假死（TCP 连上但不返回）时必须自己先给结论，不能挂到探针超时 */
const READINESS_CHECK_TIMEOUT_MS = 2_000

/** 给依赖探活加超时；超时按「不可用」处理（`Promise.race` 已消费原 promise 的 reject） */
const withTimeout = async (probe: Promise<unknown>, ms: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      probe,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('探活超时')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

@Controller()
@UseFilters(AppExceptionFilter)
export class OpsController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(RedisStore) private readonly redis: RedisStore,
  ) {}

  @Get('healthz')
  @HttpCode(200)
  healthz() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) }
  }

  @Get('readyz')
  @HttpCode(200)
  async readyz(@Res({ passthrough: true }) response: { status(code: number): void }) {
    const checks: Record<'db' | 'redis', 'ok' | 'failed'> = { db: 'ok', redis: 'ok' }
    const failed: string[] = []

    try {
      await withTimeout(this.db.dataSource.query('SELECT 1'), READINESS_CHECK_TIMEOUT_MS)
    } catch {
      checks.db = 'failed'
      failed.push('数据库')
    }

    try {
      await withTimeout(this.redis.ping(), READINESS_CHECK_TIMEOUT_MS)
    } catch {
      checks.redis = 'failed'
      failed.push('Redis')
    }

    if (failed.length > 0) response.status(503)
    return {
      status: failed.length > 0 ? 'degraded' : 'ok',
      checks,
      ...(failed.length > 0 ? { message: `依赖不可用：${failed.join('、')}` } : {}),
      uptimeSeconds: Math.round(process.uptime()),
    }
  }
}
