import { z } from 'zod'
import {
  ServiceRegisterResultSchema,
  type ServiceRegistration,
  type ServiceRegisterResult,
} from '@repo/contracts'

/** 网关内部接口统一套 `{ code, data }` 信封 */
const envelope = <T>(schema: z.ZodType<T>) => z.object({ code: z.number(), data: schema })

export interface CapabilityRegistryClientOptions {
  /** 网关地址，如 `http://127.0.0.1:9993` */
  baseUrl: string
  /** 内部令牌 */
  token: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * 服务向网关登记 / 心跳 / 注销的客户端。
 *
 * 服务侧不要自己拼 HTTP —— 这里只有四个方法，全部 POST + body，没有路径参数。
 */
export class CapabilityRegistryClient {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: CapabilityRegistryClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  register(registration: ServiceRegistration): Promise<ServiceRegisterResult> {
    return this.post('/v1/services/register', registration, ServiceRegisterResultSchema)
  }

  heartbeat(service: string, instanceId: string, active: number): Promise<{ known: boolean }> {
    return this.post(
      '/v1/instances/heartbeat',
      { service, instanceId, active },
      z.object({ known: z.boolean() }),
    )
  }

  deregisterInstance(service: string, instanceId: string): Promise<{ removed: boolean }> {
    return this.post(
      '/v1/instances/deregister',
      { service, instanceId },
      z.object({ removed: z.boolean() }),
    )
  }

  deregisterService(service: string): Promise<{ removed: boolean }> {
    return this.post('/v1/services/deregister', { service }, z.object({ removed: z.boolean() }))
  }

  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': this.options.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
    })
    if (!response.ok) {
      throw new Error(`网关登记接口返回 ${response.status}`)
    }
    const parsed = envelope(schema).safeParse(await response.json())
    if (!parsed.success) {
      throw new Error(`网关登记响应不符合契约：${path}`)
    }
    return parsed.data.data
  }
}

export interface CapabilityRegistrarLogger {
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
}

export interface CapabilityRegistrarOptions {
  client: CapabilityRegistryClient
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
