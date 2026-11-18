import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { AppLogger, RedisStore } from '@repo/kits'
import type { RegisteredService } from '@repo/contracts'
import { ServiceRegistry } from './service.registry.js'
import { UnsafeTargetError, allowPrivateNetworkOf, assertSafeTarget } from './target.guard.js'
import { ToolGatewayConfig, type ToolGatewayConfigValue } from '../config/app-config.js'

/**
 * 外部服务的探活（心跳）：网关每 30 秒敲一次 `GET {baseUrl}{healthPath}`。
 *
 * - 连续 3 次失败 → `down`（目录里 `available:false`，能力不消失）；连续成功 → `up`；
 * - 只探 `source=manual` 的服务：内部服务靠实例心跳，不重复探；
 * - 多实例场景下每个副本都会探（脚手架期接受重复，等上量再加分布式锁）。
 */
@Injectable()
export class CapabilityProbeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout

  constructor(
    @Inject(ServiceRegistry) private readonly registry: ServiceRegistry,
    @Inject(ToolGatewayConfig) private readonly config: ToolGatewayConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Optional() @Inject(RedisStore) private readonly redis?: RedisStore,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.runOnce(), 30_000)
    this.timer.unref?.()
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async runOnce(): Promise<void> {
    // 多副本时只让拿到锁的实例探（锁过期 25s，覆盖一轮 30s 内的探测）
    const lockKey = 'ai:capability:probe:lock'
    const token = await this.redis?.acquireLock(lockKey, 25).catch(() => null)
    if (this.redis && !token) return
    try {
      await this.probeAll()
    } finally {
      if (this.redis && token) {
        await this.redis.releaseLock(lockKey, token).catch(() => undefined)
      }
    }
  }

  private async probeAll(): Promise<void> {
    const services = await this.registry.snapshot()
    for (const service of services) {
      if (service.source !== 'manual' || service.status !== 'active') continue
      if (!service.baseUrl) continue
      await this.probe(service)
    }
  }

  async probe(service: RegisteredService): Promise<void> {
    // MCP 端点没有 HTTP 健康检查（GET 通常 405）：探活会把它误判 down，
    // 而 `pick()` 在 down 时不再派发。MCP 的可用性以调用结果为准（失败回 upstream）。
    if (service.protocol === 'mcp') return
    const target = new URL(service.healthPath || '/healthz', service.baseUrl)
    try {
      await assertSafeTarget(target.href, {
        allowHttp: service.allowHttp,
        allowPrivateNetwork: allowPrivateNetworkOf(this.config.allowPrivateNetwork),
      })
      const response = await fetch(target, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(3_000),
      })
      await this.registry.markProbe(service.service, response.ok)
    } catch (error) {
      if (error instanceof UnsafeTargetError) {
        this.logger.warn('capability_gateway.probe_unsafe_target', {
          service: service.service,
          reason: error.message,
        })
      }
      this.logger.warn('capability_gateway.probe_failed', {
        service: service.service,
        reason: error instanceof Error ? error.message : String(error),
      })
      await this.registry.markProbe(service.service, false)
    }
  }
}
