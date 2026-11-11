import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common'
import { AppLogger, RedisStore } from '@repo/kits'
import { AppErrorCodes, RunErrorStage, RunStatus, TimelineKind, TimelineRole } from '@repo/shared'
import type { Mastra } from '@mastra/core/mastra'
import { AgentConfig, type AgentConfig as AgentConfigValue } from '../core/config.js'
import { MASTRA } from '../mastra/ai.mastra.js'
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

    /**
     * `bootedAt` 必须在恢复**之前**取：恢复接管的 run 会写快照把 `updated_at` 顶到它之后，
     * 启动清理据此把它们让开（只处置"启动之后没有任何人碰过"的遗留行）。
     */
    const bootedAt = new Date()
    // 子 run 不是 durable：先标中断，父 run 的恢复重放 spawn 工具时才能识别并重启它
    try {
      await this.interruptOrphanChildrenOnBoot(bootedAt)
    } catch (error) {
      this.logger.error('ai.recovery.interrupt_children_failed', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    await this.recoverOnBoot()
    try {
      await this.interruptOrphansOnBoot(bootedAt)
    } catch (error) {
      // 启动清理失败不是致命错误：看门狗仍会在 heartbeatTimeoutMs 后兜底
      this.logger.error('ai.recovery.interrupt_failed', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }

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
   * **子 run 的启动清理**：只清理 `parent_run_id IS NOT NULL` 的进行中子 run。
   *
   * 子 agent 是临时 Mastra 对象、没有 durable 快照；父 run 的恢复会重放 `run-sub-agent`，
   * 那时必须看到 `interrupted` 才能走"原地重启"分支（见 `AgentRunner.runSubAgent`）。
   * 根 run 不在这里清理，留给 `recoverOnBoot()`。
   */
  private async interruptOrphanChildrenOnBoot(bootedAt: Date): Promise<void> {
    if (process.env.NODE_ENV === 'test') return
    if (this.config.multiInstance) return

    const interrupted = await this.runs.interruptActiveChildrenBefore(bootedAt)
    if (interrupted.length === 0) return
    for (const run of interrupted) {
      await this.timelines.append({
        conversationId: run.conversationId,
        runId: run.id,
        role: TimelineRole.System,
        kind: TimelineKind.Status,
        payload: {
          status: RunStatus.Interrupted,
          stage: RunErrorStage.Recovery,
          reason: 'process_restarted',
          operator: 'system',
        },
        finishedAt: new Date(),
      })
    }
    this.logger.warn('ai.recovery.interrupted_child_orphans', {
      count: interrupted.length,
      runIds: interrupted.map((run) => run.id),
    })
  }

  /**
   * **启动清理**：上一进程遗留的进行中运行，立即标 `interrupted`（不必等看门狗 60s）。
   *
   * 为什么单副本才做：多副本下"本地没有它的心跳"不能证明别的副本没在跑 ——
   * 那种场景的正确判据仍是心跳超时（看门狗）。单副本则不同：新进程起来了，
   * 旧进程一定已经退出，它手里的 run **不可能**还有人在管。
   *
   * 用户可见的收益：改代码触发 `node --watch` 重启、或进程崩溃重启后，
   * 会话立刻可以重新发送，而不是先吃一个 3306「该会话已有正在进行中的对话」。
   */
  private async interruptOrphansOnBoot(bootedAt: Date): Promise<void> {
    /**
     * 测试环境**不做**启动清理：`app-bootstrap` 这类用例会把整个应用跑在**开发库**上，
     * 而"单副本"的前提在测试进程 + 开发服务同时存在时不成立 —— 那会把开发者正在跑的
     * 一轮当成"上一进程遗留"标成中断。启动清理的判据本身由
     * `ai-storage-recovery.test.ts` 直接测 repository。
     */
    if (process.env.NODE_ENV === 'test') return
    if (this.config.multiInstance) {
      this.logger.log('ai.recovery.interrupt_skipped', {
        reason: '多副本部署：遗留运行交给心跳看门狗判定（别的副本可能还在跑）',
      })
      return
    }

    const interrupted = await this.runs.interruptActiveBefore(bootedAt)
    if (interrupted.length === 0) return

    for (const run of interrupted) {
      await this.timelines.append({
        conversationId: run.conversationId,
        runId: run.id,
        role: TimelineRole.System,
        kind: TimelineKind.Status,
        payload: {
          status: RunStatus.Interrupted,
          stage: RunErrorStage.Recovery,
          reason: 'process_restarted',
          operator: 'system',
        },
        finishedAt: new Date(),
      })
    }
    this.logger.warn('ai.recovery.interrupted_orphans', {
      count: interrupted.length,
      runIds: interrupted.map((run) => run.id),
    })
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
      const finishedAt = new Date()
      // 先把"已经走到哪了"从时间线数出来：超时的行也要有进度，否则看板一律显示 0 步 0 工具
      const progress = await this.runs.countProgress(candidate.id)
      const affected = await this.runs.markTimeout(candidate.id, heartbeatBefore, startedBefore, {
        reason: candidate.reason,
        stepCount: progress.stepCount,
        toolCallCount: progress.toolCallCount,
        finishedAt,
      })
      if (affected !== 1) continue // 别的副本先抢到了（或它已经自己结束了）
      swept += 1
      /**
       * 超时的 run 也要有输入快照：否则复盘时只能看到"超时了"，不知道它拿到的上下文与参数。
       * 只在**还没有快照**时补（正常路径在建流前就写过了，别拿一份残缺的覆盖它）。
       */
      try {
        const entity = await this.runs.findEntity(candidate.id)
        if (entity && !entity.requestSnapshot) {
          await this.runs.saveRequestSnapshot(candidate.id, {
            failure: {
              stage: RunErrorStage.Timeout,
              code: String(AppErrorCodes.RunTimeout),
              reason: candidate.reason,
            },
            context: null,
          })
        }
      } catch (error) {
        this.logger.warn('ai.watchdog.snapshot_failed', {
          runId: candidate.id,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      if (candidate.conversationId) {
        await this.timelines.append({
          conversationId: candidate.conversationId,
          runId: candidate.id,
          role: TimelineRole.System,
          kind: TimelineKind.Status,
          payload: {
            status: RunStatus.Failed,
            stage: RunErrorStage.Timeout,
            // 两条判据分开记：`stale_heartbeat` = 没人续租（进程/网络），`run_timeout` = 跑太久
            reason: candidate.reason,
            operator: 'system',
            heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
            runTimeoutMs: this.config.runTimeoutMs,
            stepCount: progress.stepCount,
            toolCallCount: progress.toolCallCount,
          },
          finishedAt,
        })
      }
      this.logger.warn('ai.watchdog.marked_timeout', {
        runId: candidate.id,
        conversationId: candidate.conversationId,
        reason: candidate.reason,
        stepCount: progress.stepCount,
        toolCallCount: progress.toolCallCount,
      })
    }

    return swept
  }
}
