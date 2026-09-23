import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common'
import { AppLogger, RedisStore } from '@repo/kits'
import { RunErrorStage, RunStatus, TimelineKind, TimelineRole } from '@repo/shared'
import type { Mastra } from '@mastra/core/mastra'
import { AgentConfig, type AgentConfig as AgentConfigValue } from '../core/ai.config.js'
import { MASTRA } from '../core/ai.mastra.js'
import { RunRepository } from './run.repository.js'
import { TimelineRepository } from './timeline.repository.js'

/** 恢复租约键：多副本同时启动时，只让一个副本执行恢复（其余什么都不做） */
const RECOVERY_LEASE_KEY = 'agent:recovery:lease'
/** 租约 TTL（秒）：比恢复 + 看门狗一轮的耗时宽裕即可 */
const RECOVERY_LEASE_TTL_SECONDS = 60

/**
 * 恢复与看门狗（设计文档 §3.13.1）。
 *
 * 两条职责：
 * 1. **启动恢复**：进程崩溃/重启后，把"还在跑但已经没人管"的会话恢复起来 ——
 *    取 Redis 租约（只一个副本执行）→ `recoverAllDurableAgents()`（**会重发模型调用、重跑工具，真花钱**，
 *    所以 `recovery_count` 有上限、工具必须幂等）；
 * 2. **看门狗**：进程活着但运行卡死（模型 hang 住）时，不能让 run 永远停在 `running` ——
 *    心跳过期的运行用**条件 UPDATE 抢执行权**标记超时（多副本并行跑也只有一个副本真正动手）。
 *
 * 为什么不用分布式锁做看门狗：条件 UPDATE 天然幂等，谁抢到谁处置，代码更少、失败模式更清楚。
 */
@Injectable()
export class AgentRecoveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout

  constructor(
    @Inject(MASTRA) private readonly mastra: Mastra | null,
    @Inject(AgentConfig) private readonly config: AgentConfigValue,
    @Inject(RunRepository) private readonly runs: RunRepository,
    @Inject(TimelineRepository) private readonly timelines: TimelineRepository,
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // 启动自检：声明了多实例却没配 Redis → **直接失败**。
    // 宁可起不来，也不要悄悄降级成"偶发断流、停止不生效"这种事后最难查的状态。
    if (this.config.multiInstance && !process.env.REDIS_URL) {
      throw new Error(
        'AGENT_MULTI_INSTANCE=true 但未配置 REDIS_URL：多实例下断线补发 / 停止 / 恢复租约都依赖 Redis',
      )
    }

    await this.recoverOnBoot()

    this.timer = setInterval(() => {
      void this.sweepStaleRuns().catch((error: unknown) => {
        this.logger.error('ai.watchdog.failed', {
          reason: error instanceof Error ? error.message : String(error),
        })
      })
    }, this.config.watchdogIntervalMs)
    // 不阻塞进程退出
    this.timer.unref?.()
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
  }

  /** 启动恢复：抢到租约的副本才执行（避免多副本同时重跑同一条会话） */
  private async recoverOnBoot(): Promise<void> {
    if (!this.mastra) {
      this.logger.log('ai.recovery.skipped', { reason: 'AI 未配置（未装配 Mastra 实例）' })
      return
    }
    if (!this.config.durableEnabled) {
      this.logger.log('ai.recovery.skipped', { reason: '未开启可恢复执行（AGENT_DURABLE_ENABLED=false）' })
      return
    }

    let token: string | null = null
    try {
      token = await this.redis.acquireLock(RECOVERY_LEASE_KEY, RECOVERY_LEASE_TTL_SECONDS)
    } catch (error) {
      this.logger.warn('ai.recovery.lease_failed', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    if (!token) {
      this.logger.log('ai.recovery.skipped', { reason: '另一个副本持有恢复租约' })
      return
    }

    const started = Date.now()
    try {
      const result = await this.mastra.recoverAllDurableAgents()
      this.logger.log('ai.recovery.done', {
        durationMs: Date.now() - started,
        // 结构随版本可能变化：只记我们能确定的部分
        recovered: Array.isArray(result) ? result.length : undefined,
      })
    } catch (error) {
      // 恢复失败不是致命错误：这一轮会被看门狗标成超时/中断，用户可手动重试
      this.logger.error('ai.recovery.failed', {
        reason: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      })
    } finally {
      // 租约留着不主动释放：TTL 到期自然释放，避免"释放瞬间另一个副本又抢到并重复恢复"
    }
  }

  /**
   * 看门狗一轮：找心跳过期的运行 → 条件 UPDATE 抢执行权 → 标超时 + 落审计事件。
   *
   * 返回本轮真正处置了几条（供测试与日志用）。
   */
  async sweepStaleRuns(): Promise<number> {
    const heartbeatBefore = new Date(Date.now() - this.config.heartbeatTimeoutMs)
    const startedBefore = new Date(Date.now() - this.config.runTimeoutMs)
    const candidates = await this.runs.findStale(heartbeatBefore, startedBefore)
    let swept = 0

    for (const candidate of candidates) {
      const affected = await this.runs.markTimeout(candidate.id, heartbeatBefore, startedBefore)
      if (affected !== 1) continue // 别的副本先抢到了（或它已经自己结束了）
      swept += 1
      if (candidate.conversationId) {
        await this.timelines.append({
          conversationId: candidate.conversationId,
          runId: candidate.id,
          role: TimelineRole.System,
          kind: TimelineKind.Status,
          payload: {
            status: RunStatus.Failed,
            stage: RunErrorStage.Timeout,
            reason: 'watchdog_timeout',
            operator: 'system',
            heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
            runTimeoutMs: this.config.runTimeoutMs,
          },
          finishedAt: new Date(),
        })
      }
      this.logger.warn('ai.watchdog.marked_timeout', { runId: candidate.id, conversationId: candidate.conversationId })
    }

    return swept
  }
}
