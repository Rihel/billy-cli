import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, RedisStore } from '@repo/kits'
import {
  WORKERS_ALIVE_KEY,
  WorkerRegistrationSchema,
  workerKey,
  type WorkerRegistration,
} from '@repo/contracts'
import { ToolGatewayConfig, type ToolGatewayConfigValue } from '../config/app-config.js'

const parseStringArray = (value: string | undefined): string[] => {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

/**
 * gateway 侧的 worker 发现（只读注册表）。
 *
 * 注册表是缓存：读不到 / 解析失败就跳过这个 worker，不抛错；
 * 一个都没有时回退到配置里的静态 worker URL（本地开发 / 单 worker 部署）。
 */
@Injectable()
export class WorkerDirectory {
  constructor(
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(ToolGatewayConfig) private readonly config: ToolGatewayConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async pick(toolKey: string): Promise<WorkerRegistration | null> {
    const candidates = await this.list()
    const healthy = candidates.filter(
      (worker) =>
        !worker.draining && worker.sandboxMode !== 'unavailable' && worker.tools.includes(toolKey),
    )
    if (healthy.length === 0) return this.staticFallback(toolKey)

    // 负载比最小者优先；同负载时随机，避免所有 gateway 都打同一个 worker
    healthy.sort((left, right) => {
      const leftRatio = left.active / Math.max(1, left.maxConcurrency)
      const rightRatio = right.active / Math.max(1, right.maxConcurrency)
      return leftRatio - rightRatio
    })
    const bestRatio = healthy[0]!.active / Math.max(1, healthy[0]!.maxConcurrency)
    const tied = healthy.filter(
      (worker) => worker.active / Math.max(1, worker.maxConcurrency) === bestRatio,
    )
    return tied[Math.floor(Math.random() * tied.length)] ?? healthy[0]!
  }

  /** 按 workerId 精确取（web-fetch 的 ref 亲和用）：不可用 / 不支持该工具就返回 null */
  async pickById(workerId: string, toolKey: string): Promise<WorkerRegistration | null> {
    const worker = (await this.list()).find(
      (item) => item.workerId === workerId && item.tools.includes(toolKey),
    )
    if (!worker || worker.draining || worker.sandboxMode === 'unavailable') return null
    return worker
  }

  async list(): Promise<WorkerRegistration[]> {
    let ids: string[]
    try {
      // 先按心跳时间剪掉过期项；不做全量 ZSET 扫描
      ids = await this.redis.zrangeByScore(
        WORKERS_ALIVE_KEY,
        Date.now() - this.config.staleAfterMs,
        '+inf',
        {
          offset: 0,
          count: 50,
        },
      )
    } catch (error) {
      this.logger.warn('tool_gateway.registry_unavailable', {
        reason: error instanceof Error ? error.message : String(error),
      })
      return []
    }

    const workers: WorkerRegistration[] = []
    for (const id of ids) {
      try {
        const raw = await this.redis.hgetall(workerKey(id))
        if (!raw.endpoint) continue
        const parsed = WorkerRegistrationSchema.safeParse({
          workerId: id,
          endpoint: raw.endpoint,
          version: raw.version ?? 'unknown',
          zone: raw.zone ?? 'unknown',
          executors: parseStringArray(raw.executors),
          tools: parseStringArray(raw.tools),
          sandboxMode: raw.sandboxMode ?? 'unknown',
          maxConcurrency: Number(raw.maxConcurrency ?? 1),
          active: Number(raw.active ?? 0),
          draining: raw.draining === '1',
          startedAt: raw.startedAt ?? new Date(0).toISOString(),
        })
        if (parsed.success) workers.push(parsed.data)
      } catch (error) {
        this.logger.warn('tool_gateway.worker_parse_failed', {
          workerId: id,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return workers
  }

  private staticFallback(toolKey: string): WorkerRegistration | null {
    if (!this.config.workerUrl) return null
    return {
      workerId: 'static',
      endpoint: this.config.workerUrl,
      version: 'static',
      zone: 'static',
      executors: ['bash'],
      tools: toolKey === 'bash' ? ['bash'] : [toolKey],
      sandboxMode: 'unknown',
      maxConcurrency: 1,
      active: 0,
      draining: false,
      startedAt: new Date(0).toISOString(),
    }
  }
}
