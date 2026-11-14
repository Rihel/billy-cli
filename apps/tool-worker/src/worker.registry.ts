import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { AppLogger, RedisStore, WorkspaceRuntimeService } from '@repo/kits'
import {
  WORKERS_ALIVE_KEY,
  WorkerRegistrationSchema,
  workerKey,
  type WorkerRegistration,
} from '@repo/contracts'
import { ToolWorkerConfig, type ToolWorkerConfigValue } from './config/app-config.js'
import { ToolExecutorRegistry } from './executors/executor.registry.js'

/**
 * worker 自注册（Redis）：
 *
 * - `ai:tool-worker:<id>` 存能力 / 端点 / 负载，`ai:tool-workers:alive` 的 score 是最后心跳；
 * - 心跳 10s、30s 过期；gateway 只按心跳新鲜度选路；
 * - `active` 是近似值：worker 自己也会限并发，满了返回 busy，gateway 换一个；
 * - worker 死了注册自然过期；**在跑任务靠 job lease**，不是这个注册表。
 */
@Injectable()
export class WorkerRegistry implements OnApplicationBootstrap, OnApplicationShutdown {
  private active = 0
  private draining = false
  private sandboxMode = 'unknown'
  private timer?: NodeJS.Timeout

  constructor(
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(ToolWorkerConfig) private readonly config: ToolWorkerConfigValue,
    @Inject(ToolExecutorRegistry) private readonly executors: ToolExecutorRegistry,
    @Inject(WorkspaceRuntimeService) private readonly workspace: WorkspaceRuntimeService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const status = await this.workspace.status().catch(() => null)
    this.sandboxMode =
      status?.mode === 'off' ? 'off' : status?.sandbox.available ? 'enforce' : 'unavailable'
    if (this.sandboxMode === 'unavailable') {
      this.logger.warn('tool_worker.sandbox_unavailable', {
        reason: status?.sandbox.reason?.message ?? 'unknown',
      })
    }
    await this.publish()
    this.timer = setInterval(() => {
      void this.publish()
    }, this.config.heartbeatIntervalMs)
    this.timer.unref?.()
  }

  async onApplicationShutdown(): Promise<void> {
    this.draining = true
    if (this.timer) clearInterval(this.timer)
    // 先让 gateway 看到 draining，再删除注册；在跑任务由调用方自己收尾
    await this.publish().catch(() => undefined)
    await Promise.all([
      this.redis.del(workerKey(this.config.id)),
      this.redis.zrem(WORKERS_ALIVE_KEY, this.config.id),
    ]).catch((error: unknown) => {
      this.logger.warn('tool_worker.unregister_failed', {
        reason: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /** 尝试占用一个执行槽；满了返回 false（调用方回 busy，不排队） */
  acquire(): boolean {
    if (this.draining || this.active >= this.config.maxConcurrency) return false
    this.active += 1
    void this.publish()
    return true
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
    void this.publish()
  }

  snapshot(): WorkerRegistration {
    return WorkerRegistrationSchema.parse({
      workerId: this.config.id,
      endpoint: this.config.endpoint,
      version: this.config.version,
      zone: this.config.zone,
      executors: this.executors.tools(),
      tools: this.executors.tools(),
      sandboxMode: this.sandboxMode,
      maxConcurrency: this.config.maxConcurrency,
      active: this.active,
      draining: this.draining,
      startedAt: this.startedAt,
    })
  }

  private readonly startedAt = new Date().toISOString()

  private async publish(): Promise<void> {
    const snapshot = this.snapshot()
    const key = workerKey(snapshot.workerId)
    try {
      await this.redis.hset(key, {
        workerId: snapshot.workerId,
        endpoint: snapshot.endpoint,
        version: snapshot.version,
        zone: snapshot.zone,
        executors: JSON.stringify(snapshot.executors),
        tools: JSON.stringify(snapshot.tools),
        sandboxMode: snapshot.sandboxMode,
        maxConcurrency: String(snapshot.maxConcurrency),
        active: String(snapshot.active),
        draining: snapshot.draining ? '1' : '0',
        startedAt: snapshot.startedAt,
      })
      await this.redis.zadd(WORKERS_ALIVE_KEY, Date.now(), snapshot.workerId)
      // 过期只用于「进程被直接杀掉」的兜底；正常路径每次心跳都会续
      await this.redis.pexpire(key, this.config.staleAfterMs * 2)
    } catch (error) {
      // Redis 抖动不带走 worker：命令还能执行，只是 gateway 暂时看不到它
      this.logger.warn('tool_worker.heartbeat_failed', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
