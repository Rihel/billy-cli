import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { RunStatus } from '@repo/shared'
import { AgentChatService } from './chat.service.js'
import { ConversationBusyError } from '../core/errors.js'
import { ConversationRunQueue } from './run-queue.service.js'
import { RunRepository } from './run.repository.js'

/** 轮询间隔（进程内的兜底触发；事件路径仍然是"有新东西就 tick 一次"） */
const TICK_INTERVAL_MS = 1_000

/** 终态集合：`dispatching/started` 的队列项据此补收尾 */
const TERMINAL = new Set<string>([
  RunStatus.Succeeded,
  RunStatus.Failed,
  RunStatus.Canceled,
  RunStatus.Interrupted,
])

/**
 * 会话 run 队列的**调度器**（异步子 agent + 用户消息排队）。
 *
 * 它只做三件事（设计 `docs/design/async-subagent.md` §4）：
 * 1. 找有 `queued` 项的会话；
 * 2. 会话空闲时原子取队首（`priority` 升序，用户 0 优先于子 agent 1）；
 * 3. 把队首交给 `AgentChatService.startQueuedTurn` 起一轮，跑完把队列项收尾。
 *
 * 为什么是"轮询 + 原子 claim"而不是"事件直达"：入队可能发生在别的副本 / 进程重启前后，
 * 事件会丢；队列本身在 Postgres 里，轮询是**幂等**的兜底。`claimNext` 用 Redis 锁 +
 * 条件 UPDATE，所以多副本同时轮询也只会有一个副本取到同一条。
 */
@Injectable()
export class ConversationRunQueueDispatcher implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null
  /** 本进程正在为哪些会话跑轮次（同一会话串行；跨副本靠 claim + 唯一索引兜底） */
  private readonly inFlight = new Set<string>()
  private ticking = false

  constructor(
    @Inject(ConversationRunQueue) private readonly queue: ConversationRunQueue,
    @Inject(RunRepository) private readonly runs: RunRepository,
    @Inject(AgentChatService) private readonly chat: AgentChatService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_RUN_QUEUE_DISPATCHER === '1') return
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.error('ai.run_queue.tick_failed', {
          reason: error instanceof Error ? error.message : String(error),
        })
      })
    }, TICK_INTERVAL_MS)
    this.timer.unref?.()
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 扫一轮：先对账未收尾的调度项，再给空闲会话派活。
   *
   * 每个会话的轮次**不阻塞**其它会话（长回答可能跑几分钟）：派出去就返回，
   * `inFlight` 保证同一会话不会被重复调度。
   */
  async tick(onlyConversationIds?: readonly string[]): Promise<number> {
    if (this.ticking) return 0
    this.ticking = true
    let started = 0
    try {
      await this.reconcile()
      const conversationIds =
        onlyConversationIds && onlyConversationIds.length > 0
          ? [...onlyConversationIds]
          : await this.queue.listQueuedConversationIds()
      for (const conversationId of conversationIds) {
        if (this.inFlight.has(conversationId)) continue
        this.inFlight.add(conversationId)
        started += 1
        void this.dispatch(conversationId)
          .catch((error: unknown) => {
            this.logger.error('ai.run_queue.dispatch_failed', {
              conversationId,
              reason: error instanceof Error ? error.message : String(error),
            })
          })
          .finally(() => {
            this.inFlight.delete(conversationId)
          })
      }
    } finally {
      this.ticking = false
    }
    return started
  }

  /**
   * 给一个会话派下一项（会话空闲才有活干）。
   *
   * 返回 true = 确实起了一轮（含跑完）；false = 没有可派 / 会话忙 / 竞态放回队列。
   */
  async dispatch(conversationId: string): Promise<boolean> {
    // 真相在 `runs`（部分唯一索引兜底并发）：有活动根 run 就不取队首，避免"取出来又起不来"
    const active = await this.runs.findActive(conversationId)
    if (active) return false

    const item = await this.queue.claimNext(conversationId)
    if (!item) return false

    /**
     * 结果已经被父 agent 拿走（`wait-sub-agent` 消费）→ 这一条只是"迟到的唤醒"，直接收尾不起 run。
     *
     * 查询点必须在**取到之后、起 run 之前**：`claimNext` 与父的 `wait-sub-agent` 是两条并发路径，
     * 谁先谁后不确定，只有在这里兜一次才不会起一轮"结论早就用过"的空转（2026-11-15 实测）。
     */
    if (
      item.source === 'subagent' &&
      item.dedupeKey &&
      (await this.queue.isConsumed(item.dedupeKey))
    ) {
      await this.queue.markDone(item.id)
      this.logger.log('ai.run_queue.skipped_consumed', {
        conversationId,
        queueId: item.id,
        dedupeKey: item.dedupeKey,
      })
      return false
    }

    try {
      const handle = await this.chat.startQueuedTurn(item)
      // run 已创建：立刻落 run_id（进程在"建了 run、还没标 started"之间被杀也能对账）
      await this.queue.markStarted(item.id, handle.runId)
      const status = await handle.done
      await this.queue.finishByRun(
        handle.runId,
        status === 'succeeded' ? 'done' : status === 'canceled' ? 'canceled' : 'failed',
        status === 'failed' ? '执行失败，详情见 runs 的错误字段' : undefined,
      )
      this.logger.log('ai.run_queue.dispatched', {
        conversationId,
        queueId: item.id,
        source: item.source,
        runId: handle.runId,
        result: status,
      })
      return true
    } catch (error) {
      if (error instanceof ConversationBusyError) {
        // 检查与 claim 之间被别的一轮抢到了：放回队列，下一次 tick 再取（不是失败）
        await this.queue.requeue(item.id)
        return false
      }
      const reason = error instanceof Error ? error.message : String(error)
      await this.queue.markFailed(item.id, reason)
      this.logger.error('ai.run_queue.dispatch_failed', {
        conversationId,
        queueId: item.id,
        source: item.source,
        reason,
      })
      return false
    }
  }

  /**
   * 对账：把"起了 run 但没走完收尾流程"的队列项补成正确状态。
   *
   * 两个真实场景：进程在 `markStarted` 之前被 SIGKILL；run 已终态但 dispatcher 的
   * `finishByRun` 没来得及执行（重启）。两者都在这里收敛，队列项不会永远卡在 started。
   */
  private async reconcile(): Promise<void> {
    await this.queue.recoverStale()
    const rows = await this.queue.listUnfinished()
    for (const row of rows) {
      if (!row.runId) continue // 没有 run 的由 recoverStale 处理（超时回 queued）
      const run = await this.runs.findEntity(row.runId)
      if (!run) {
        await this.queue.markFailed(row.id, '对应的 run 不存在')
        continue
      }
      if (TERMINAL.has(run.status)) {
        // `finishByRun` 只收 started：进程在 markStarted 之前被杀时先补这一笔
        if (row.status === 'dispatching') await this.queue.markStarted(row.id, run.id)
        await this.queue.finishByRun(
          run.id,
          run.status === RunStatus.Succeeded
            ? 'done'
            : run.status === RunStatus.Canceled
              ? 'canceled'
              : 'failed',
        )
        continue
      }
      // run 还在跑，但队列项停在 dispatching（进程在两步之间被杀）：补成 started
      if (row.status === 'dispatching') await this.queue.markStarted(row.id, run.id)
    }
  }
}
