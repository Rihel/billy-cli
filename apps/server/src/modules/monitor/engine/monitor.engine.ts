import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { AppLogger, RedisStore } from '@repo/kits'
import { MonitorConfig, type MonitorConfig as MonitorConfigType } from '../config.js'
import type { MonitorErrorEvent } from '../definitions/rule.types.js'
import { CleanupService } from './cleanup.service.js'
import { EventRuleService } from './event-rule.service.js'
import { MetricCollectService } from './metric-collect.service.js'
import { MonitorTimeline } from './monitor.timeline.js'
import { RuleEvaluatorService } from './rule-evaluator.service.js'
import { RuleRegistry } from './rule.registry.js'
import { SeedService } from './seed.service.js'

export interface SlotRunState {
  intervalSeconds: number
  lastRunAt: Date | null
  lastDurationMs: number | null
  running: boolean
}

/** 引擎：启动对账 + 槽位编排 + 异常入口 */
@Injectable()
export class MonitorEngine implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly slotRuns = new Map<number, SlotRunState>()
  private lastLeader = false

  constructor(
    @Inject(MonitorConfig) private readonly config: MonitorConfigType,
    @Inject(MetricCollectService) private readonly collector: MetricCollectService,
    @Inject(RuleRegistry) private readonly rules: RuleRegistry,
    @Inject(RuleEvaluatorService) private readonly evaluator: RuleEvaluatorService,
    @Inject(EventRuleService) private readonly events: EventRuleService,
    @Inject(CleanupService) private readonly cleanup: CleanupService,
    @Inject(SeedService) private readonly seed: SeedService,
    @Inject(MonitorTimeline) private readonly timeline: MonitorTimeline,
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seed.sync()
    this.timeline.start((intervalSeconds) => this.runSlot(intervalSeconds))
  }

  onApplicationShutdown(): void {
    this.timeline.onApplicationShutdown()
  }

  slotStatus(): SlotRunState[] {
    return [...this.slotRuns.values()].sort((a, b) => a.intervalSeconds - b.intervalSeconds)
  }

  isLeader(): boolean {
    return this.lastLeader
  }

  /** 槽到点：所有实例采集本实例指标，leader 评估规则 */
  async runSlot(intervalSeconds: number): Promise<void> {
    const started = Date.now()
    const previous = this.slotRuns.get(intervalSeconds)
    this.slotRuns.set(intervalSeconds, {
      intervalSeconds,
      lastRunAt: previous?.lastRunAt ?? null,
      lastDurationMs: previous?.lastDurationMs ?? null,
      running: true,
    })

    try {
      try {
        await this.collector.collectInstance(intervalSeconds)
      } catch (error) {
        this.logger.error('monitor.collect.failed', { intervalSeconds, error })
        return
      }

      const lockKey = `monitor:eval:${intervalSeconds}`
      const token = await this.redis.acquireLock(lockKey, 30)
      this.lastLeader = token !== null
      if (!token) return

      try {
        await this.collector.collectGlobal(intervalSeconds)
        const now = new Date()
        for (const rule of this.rules.forInterval(intervalSeconds)) {
          try {
            await this.evaluator.evaluate(rule, now)
          } catch (error) {
            this.logger.error('monitor.rule.failed', { ruleKey: rule.key, error })
          }
        }
        if (intervalSeconds === 60) {
          try {
            await this.events.sweep(now)
          } catch (error) {
            this.logger.error('monitor.event.sweep_failed', { error })
          }
        }
        await this.cleanup.maybeCleanup(now)
      } finally {
        await this.redis.releaseLock(lockKey, token)
      }
    } finally {
      this.slotRuns.set(intervalSeconds, {
        intervalSeconds,
        lastRunAt: new Date(),
        lastDurationMs: Date.now() - started,
        running: false,
      })
    }
  }

  /** 异常入口：错误码 / 关键字匹配，Redis 计次后触发事件规则 */
  async ingestError(error: unknown, context?: { path?: string; requestId?: string }): Promise<void> {
    if (!this.config.enabled) return
    const event: MonitorErrorEvent = {
      code: errorCodeOf(error),
      message: errorMessageOf(error),
      stack: error instanceof Error ? error.stack : undefined,
      path: context?.path,
      requestId: context?.requestId,
      at: new Date(),
    }
    try {
      await this.events.ingest(event)
    } catch (cause) {
      this.logger.error('monitor.event.ingest_failed', { error: cause })
    }
  }
}

const errorCodeOf = (error: unknown): number | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof (error as { code?: unknown }).code === 'number'
    ? (error as { code: number }).code
    : undefined

const errorMessageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
