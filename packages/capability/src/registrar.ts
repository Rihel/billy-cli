import type { ServiceRegistration, ServiceRegisterResult } from '@repo/contracts'

/**
 * 登记用的**最小客户端接口**（机制包不反向依赖 `@repo/internal-sdk`）。
 *
 * HTTP 只在 `@repo/internal-sdk` 的 `CapabilityGatewayClient` 里拼（路径 / 令牌 / 信封 / 超时
 * 都归它管）；本包只留生命周期编排，`CapabilityGatewayClient` 结构上即满足这个接口。
 */
export interface CapabilityRegistrarClient {
  register(registration: ServiceRegistration): Promise<ServiceRegisterResult>
  heartbeat(service: string, instanceId: string, active: number): Promise<{ known: boolean }>
  deregisterInstance(service: string, instanceId: string): Promise<{ removed: boolean }>
}

export interface CapabilityRegistrarLogger {
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
}

export interface CapabilityRegistrarOptions {
  client: CapabilityRegistrarClient
  registration: ServiceRegistration
  /** 心跳间隔，默认 10 秒 */
  heartbeatIntervalMs?: number
  /** 当前在跑多少个（心跳带上），默认 0 */
  activeProvider?: () => number
  logger?: CapabilityRegistrarLogger
}

/**
 * 服务生命周期里的登记动作：
 *
 * `start()` 上报清单（失败退避重试，不阻塞进程启动）→ 每 10 秒心跳 →
 * 心跳返回 `known=false` 时自动重发 register → `stop()` 注销本实例。
 */
export class CapabilityRegistrar {
  private timer?: ReturnType<typeof setInterval>
  private retry?: ReturnType<typeof setTimeout>
  private stopped = false
  private readonly intervalMs: number
  private readonly service: string
  private readonly instanceId?: string

  constructor(private readonly options: CapabilityRegistrarOptions) {
    this.intervalMs = options.heartbeatIntervalMs ?? 10_000
    this.service = options.registration.service
    this.instanceId = options.registration.instance?.instanceId
  }

  async start(): Promise<void> {
    await this.registerOnce()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
  }

  /** 心跳：内部服务才有；外部服务（没有 instance）不发 */
  async tick(): Promise<void> {
    if (this.stopped || this.instanceId === undefined) return
    try {
      const result = await this.options.client.heartbeat(
        this.service,
        this.instanceId,
        this.options.activeProvider?.() ?? 0,
      )
      if (!result.known) await this.registerOnce()
    } catch (error) {
      this.options.logger?.warn('capability.heartbeat_failed', {
        service: this.service,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.retry) clearTimeout(this.retry)
    if (this.instanceId === undefined) return
    await this.options.client
      .deregisterInstance(this.service, this.instanceId)
      .catch((error: unknown) =>
        this.options.logger?.warn('capability.deregister_failed', {
          service: this.service,
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
  }

  private async registerOnce(): Promise<void> {
    try {
      await this.options.client.register(this.options.registration)
      this.options.logger?.info('capability.registered', { service: this.service })
    } catch (error) {
      this.options.logger?.warn('capability.register_failed', {
        service: this.service,
        reason: error instanceof Error ? error.message : String(error),
      })
      if (this.stopped || this.retry) return
      this.retry = setTimeout(() => {
        this.retry = undefined
        void this.registerOnce()
      }, 5_000)
      this.retry.unref?.()
    }
  }
}
