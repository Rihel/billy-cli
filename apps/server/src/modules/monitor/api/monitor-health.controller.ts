import { Controller, HttpCode, Inject, Post } from '@nestjs/common'
import { Db, RedisStore } from '@repo/kits'

/** 健康检查路由（/monitor/health，免鉴权）：探活 DB / Redis，任一失败 degraded。 */
@Controller('monitor')
export class MonitorHealthController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(RedisStore) private readonly redis: RedisStore,
  ) {}

  @Post('health')
  @HttpCode(200)
  async health() {
    const checks: Record<string, 'ok' | 'failed'> = {}
    let status: 'ok' | 'degraded' = 'ok'

    try {
      await this.db.dataSource.query('SELECT 1')
      checks.db = 'ok'
    } catch {
      checks.db = 'failed'
      status = 'degraded'
    }
    try {
      await this.redis.raw.ping()
      checks.redis = 'ok'
    } catch {
      checks.redis = 'failed'
      status = 'degraded'
    }

    return {
      status,
      uptimeSeconds: Math.round(process.uptime()),
      checks,
    }
  }
}
