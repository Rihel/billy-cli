import { Controller, Get, HttpCode, Inject, Res, UseFilters } from '@nestjs/common'
import { AppExceptionFilter, RedisStore } from '@repo/kits'

/**
 * 网关探针（**唯一允许 GET 的地方**）。
 *
 * 业务路由全在 `registry/capability-registry.controller.ts`：一律 POST + body、无路径参数。
 */
@Controller()
@UseFilters(AppExceptionFilter)
export class GatewayHealthController {
  constructor(@Inject(RedisStore) private readonly redis: RedisStore) {}

  @Get('healthz')
  @HttpCode(200)
  healthz() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) }
  }

  /** readiness：进程 + Redis；能力数量作为观测值返回，不因为 0 个而摘掉网关 */
  @Get('readyz')
  @HttpCode(200)
  async readyz(@Res({ passthrough: true }) response: { status(code: number): void }) {
    let redisOk = true
    try {
      await this.redis.ping()
    } catch {
      redisOk = false
    }
    if (!redisOk) response.status(503)
    const services = await this.redis
      .getJson<{ services?: Record<string, unknown> }>('ai:capability:registry')
      .catch((): { services?: Record<string, unknown> } | null => null)
    return {
      status: redisOk ? 'ok' : 'degraded',
      redis: redisOk ? 'ok' : 'failed',
      services: Object.keys(services?.services ?? {}).length,
    }
  }
}
