import { Inject, Injectable } from '@nestjs/common'
import { ConversationRunQueueEntity } from '@repo/db'
import { In } from 'typeorm'
import { AppLogger, Db, RedisStore } from '@repo/kits'

/** 队列来源：用户消息 / 子 agent 完成唤醒 */
export type RunQueueSource = 'user' | 'subagent'

/** 队列状态（只描述调度，不描述 run 执行结果） */
export type RunQueueStatus = 'queued' | 'dispatching' | 'started' | 'done' | 'canceled' | 'failed'

export interface EnqueueRunInput {
  conversationId: string
  source: RunQueueSource
  payload: Record<string, unknown>
  /** 子 agent 完成用 subRunId；用户消息可空 */
  dedupeKey?: string | null
}

const LOCK_TTL_SECONDS = 15
const DISPATCHING_STALE_MS = 120_000
/** 每会话排队上限（设计 §8 建议 50）：超限拒绝入队，不无限堆积 */
const MAX_QUEUED_PER_CONVERSATION = 50

const lockKey = (conversationId: string): string => `ai:run-queue:dispatch:${conversationId}`

/**
 * 「这个子 run 的结果已经交付给父 agent」的标记键（`dedupeKey` = 子 run id）。
 *
 * 为什么除了队列行还要一个标记：队列行只在**入队之后**才存在，而子 run 翻终态在入队之前
 * （落结论文件、回写用量都在中间），父的 `wait-sub-agent` 可能先拿到结果、那时还没有队列行。
 * 标记把「已交付」这个事实与行的存在解耦，入队端与调度端都查它。
 */
const consumedKey = (dedupeKey: string): string => `ai:subagent:delivered:${dedupeKey}`

/** 标记保留 7 天：足够覆盖「父 run 迟迟不收尾 / 进程重启」的窗口，又不无限涨 */
const CONSUMED_TTL_SECONDS = 7 * 24 * 3600

/**
 * 父会话的 root run 队列（异步子 agent 的基础设施）。
 *
 * 只做**调度意图**：入队、取队首、标记状态、取消、回收卡死的 dispatching。
 * 真正创建 run / 流式输出由 dispatcher / chat service 负责，避免这里反向依赖 AI 业务。
 */
@Injectable()
export class ConversationRunQueue {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /**
   * 入队；dedupeKey 冲突时返回已有行（幂等）；超过每会话上限抛错。
   *
   * 容量检查与插入必须在**同一个事务 + 会话级 advisory lock** 里：多副本同时入队时
   * `count -> insert` 的 check-then-act 会让 50 条上限被突破。锁只按 conversation 串行，
   * 不同会话互不影响；dedupe 也放在锁内先查，已入队的重试不会被容量误拒。
   */
  async enqueue(input: EnqueueRunInput): Promise<ConversationRunQueueEntity> {
    try {
      return await this.db.dataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `run_queue:${input.conversationId}`,
        ])
        const repo = manager.getRepository(ConversationRunQueueEntity)
        if (input.dedupeKey) {
          const existing = await repo.findOne({ where: { dedupeKey: input.dedupeKey } })
          if (existing) return existing
        }
        const pending = await repo.count({
          where: { conversationId: input.conversationId, status: 'queued' },
        })
        if (pending >= MAX_QUEUED_PER_CONVERSATION) {
          throw new Error(
            `该会话已有 ${pending} 条待处理消息（上限 ${MAX_QUEUED_PER_CONVERSATION}），请等当前任务结束后再发`,
          )
        }
        const saved = await repo.save(
          repo.create({
            conversationId: input.conversationId,
            source: input.source,
            priority: input.source === 'user' ? 0 : 1,
            status: 'queued',
            dedupeKey: input.dedupeKey ?? null,
            payload: input.payload,
          }),
        )
        this.logger.log('ai.run_queue.enqueued', {
          queueId: saved.id,
          conversationId: input.conversationId,
          source: input.source,
        })
        return saved
      })
    } catch (error) {
      // 事务已回滚；并发的同 dedupeKey 可能刚插入成功，回读一次保证幂等
      if (input.dedupeKey) {
        const existing = await this.db
          .getRepository(ConversationRunQueueEntity)
          .findOne({ where: { dedupeKey: input.dedupeKey } })
        if (existing) return existing
      }
      throw error
    }
  }

  /**
   * 取队首并原子标记 dispatching：`user` 优先，同优先级 FIFO。
   * 多副本用 Redis 锁串行化；拿不到锁返回 null（下一次事件会再试）。
   */
  async claimNext(conversationId: string): Promise<ConversationRunQueueEntity | null> {
    const token = await this.redis.acquireLock(lockKey(conversationId), LOCK_TTL_SECONDS)
    if (!token) return null
    try {
      const repo = this.db.getRepository(ConversationRunQueueEntity)
      const next = await repo
        .createQueryBuilder('q')
        .where('q.conversationId = :conversationId', { conversationId })
        .andWhere('q.status = :status', { status: 'queued' })
        .orderBy('q.priority', 'ASC')
        .addOrderBy('q.createdAt', 'ASC')
        .getOne()
      if (!next) return null
      const updated = await repo
        .createQueryBuilder()
        .update(ConversationRunQueueEntity)
        .set({ status: 'dispatching', startedAt: new Date() })
        .where('id = :id AND status = :status', { id: next.id, status: 'queued' })
        .execute()
      if ((updated.affected ?? 0) === 0) return null
      this.logger.log('ai.run_queue.claimed', {
        queueId: next.id,
        conversationId,
        source: next.source,
      })
      next.status = 'dispatching'
      next.startedAt = new Date()
      return next
    } finally {
      await this.redis.releaseLock(lockKey(conversationId), token)
    }
  }

  /**
   * 取到但没能起跑（会话又被占用 / 竞态）：放回队列，下一轮再取。
   *
   * 必须带 `from='dispatching'`：取消可能在这两步之间发生，无条件的 update 会把
   * 已取消的项复活成 queued，下一轮又执行一条用户已经删掉的请求。
   */
  async requeue(id: string): Promise<boolean> {
    const result = await this.db
      .getRepository(ConversationRunQueueEntity)
      .createQueryBuilder()
      .update(ConversationRunQueueEntity)
      .set({ status: 'queued', startedAt: null })
      .where('id = :id AND status = :status', { id, status: 'dispatching' })
      .execute()
    return (result.affected ?? 0) > 0
  }

  /** `dispatching -> started` 的条件转移；返回 false = 队列项已被取消 / 已换手 */
  async markStarted(id: string, runId: string): Promise<boolean> {
    const result = await this.db
      .getRepository(ConversationRunQueueEntity)
      .createQueryBuilder()
      .update(ConversationRunQueueEntity)
      .set({ status: 'started', runId })
      .where('id = :id AND status = :status', { id, status: 'dispatching' })
      .execute()
    return (result.affected ?? 0) > 0
  }

  async markDone(id: string): Promise<boolean> {
    const result = await this.db
      .getRepository(ConversationRunQueueEntity)
      .createQueryBuilder()
      .update(ConversationRunQueueEntity)
      .set({ status: 'done', finishedAt: new Date() })
      .where('id = :id AND status IN (:...statuses)', {
        id,
        statuses: ['dispatching', 'started'],
      })
      .execute()
    return (result.affected ?? 0) > 0
  }

  async markFailed(id: string, error: string): Promise<boolean> {
    const result = await this.db
      .getRepository(ConversationRunQueueEntity)
      .createQueryBuilder()
      .update(ConversationRunQueueEntity)
      .set({ status: 'failed', error, finishedAt: new Date() })
      .where('id = :id AND status IN (:...statuses)', {
        id,
        statuses: ['dispatching', 'started'],
      })
      .execute()
    return (result.affected ?? 0) > 0
  }

  /** 取消一个队列项（已 started/done 的不动） */
  async cancel(id: string): Promise<boolean> {
    const result = await this.db
      .getRepository(ConversationRunQueueEntity)
      .createQueryBuilder()
      .update(ConversationRunQueueEntity)
      .set({ status: 'canceled', finishedAt: new Date() })
      .where('id = :id AND status IN (:...statuses)', {
        id,
        statuses: ['queued', 'dispatching'],
      })
      .execute()
    return (result.affected ?? 0) > 0
  }

  /** 取消某会话的排队项（可按 source 过滤）；用于父 stop / 删会话 */
  async cancelConversation(conversationId: string, source?: RunQueueSource): Promise<number> {
    const qb = this.db
      .getRepository(ConversationRunQueueEntity)
      .createQueryBuilder()
      .update(ConversationRunQueueEntity)
      .set({ status: 'canceled', finishedAt: new Date() })
      .where('conversationId = :conversationId', { conversationId })
      .andWhere('status IN (:...statuses)', { statuses: ['queued', 'dispatching'] })
    if (source) qb.andWhere('source = :source', { source })
    const result = await qb.execute()
    return result.affected ?? 0
  }

  /** 取消某个子 run 的唤醒项（子 agent 被 cancel 时） */
  async cancelByDedupe(dedupeKey: string): Promise<boolean> {
    const result = await this.db
      .getRepository(ConversationRunQueueEntity)
      .createQueryBuilder()
      .update(ConversationRunQueueEntity)
      .set({ status: 'canceled', finishedAt: new Date() })
      .where('dedupeKey = :dedupeKey AND status IN (:...statuses)', {
        dedupeKey,
        statuses: ['queued', 'dispatching'],
      })
      .execute()
    return (result.affected ?? 0) > 0
  }

  /** 进程重启：长时间停在 dispatching 且没有 run 的项回到 queued */
  async recoverStale(now = Date.now()): Promise<number> {
    const cutoff = new Date(now - DISPATCHING_STALE_MS)
    const result = await this.db
      .getRepository(ConversationRunQueueEntity)
      .createQueryBuilder()
      .update(ConversationRunQueueEntity)
      .set({ status: 'queued', startedAt: null })
      .where('status = :status AND (runId IS NULL OR runId = :empty)', {
        status: 'dispatching',
        empty: '',
      })
      .andWhere('startedAt < :cutoff', { cutoff })
      .execute()
    return result.affected ?? 0
  }

  /** 某个子 run 的完成是否已在队列里（用于 wait 消费/幂等检查） */
  async findByDedupe(dedupeKey: string): Promise<ConversationRunQueueEntity | null> {
    return this.db.getRepository(ConversationRunQueueEntity).findOne({ where: { dedupeKey } })
  }

  /** `wait-sub-agent` 已拿到结果：消费唤醒项，避免父 run 结束后重复唤醒 */
  async consumeByDedupe(dedupeKey: string): Promise<boolean> {
    const result = await this.db
      .getRepository(ConversationRunQueueEntity)
      .createQueryBuilder()
      .update(ConversationRunQueueEntity)
      .set({ status: 'done', finishedAt: new Date() })
      .where('dedupeKey = :dedupeKey AND status = :status', { dedupeKey, status: 'queued' })
      .execute()
    return (result.affected ?? 0) > 0
  }

  /**
   * 标记「这个子 run 的结果已经交付父 agent」，之后不再为它唤醒。
   *
   * 与 {@link consumeByDedupe} 的区别：那个改的是**已经存在的队列行**，这个记的是**事实**，
   * 所以入队晚到（队列行还没建）时也能挡住 —— 两者配合才没有时序窗口。
   */
  async markConsumed(dedupeKey: string): Promise<void> {
    await this.redis.set(consumedKey(dedupeKey), '1', CONSUMED_TTL_SECONDS)
  }

  /** 该子 run 的结果是否已交付父 agent */
  async isConsumed(dedupeKey: string): Promise<boolean> {
    return (await this.redis.exists(consumedKey(dedupeKey))) > 0
  }

  /**
   * 本会话里**还排着队、没被消费**的子 agent 完成项（返回 `dedupeKey` = 子 run id）。
   *
   * `wait-sub-agent` 用它把「已经完成、但唤醒还没被谁消费」的子也收进这次收口：
   * 否则它们会在父 run 结束后补一轮唤醒（2026-11-15 实测：父已经读过结论，仍被唤醒一次）。
   */
  async listQueuedSubAgentKeys(conversationId: string): Promise<string[]> {
    const rows = await this.db.getRepository(ConversationRunQueueEntity).find({
      where: { conversationId, source: 'subagent', status: 'queued' },
      select: { dedupeKey: true },
    })
    return rows
      .map((row) => row.dedupeKey)
      .filter((key): key is string => typeof key === 'string' && key.length > 0)
  }

  async pendingCount(conversationId: string): Promise<number> {
    return this.db.getRepository(ConversationRunQueueEntity).count({
      where: { conversationId, status: 'queued' },
    })
  }

  /**
   * 有排队项在等调度的会话（dispatcher 每个 tick 用它找活干）。
   *
   * 按 `created_at` 升序：先排队的会话先被扫描，避免饿死。
   */
  async listQueuedConversationIds(limit = 50): Promise<string[]> {
    const rows = await this.db
      .getRepository(ConversationRunQueueEntity)
      .createQueryBuilder('q')
      .select('q.conversation_id', 'conversationId')
      .addSelect('MIN(q.created_at)', 'firstAt')
      .where('q.status = :status', { status: 'queued' })
      .groupBy('q.conversation_id')
      .orderBy('MIN(q.created_at)', 'ASC')
      .limit(limit)
      .getRawMany<{ conversationId: string }>()
    return rows.map((row) => row.conversationId)
  }

  /** 某一轮跑完：把对应的 started 队列项收尾（dispatcher 用） */
  async finishByRun(
    runId: string,
    status: 'done' | 'failed' | 'canceled',
    error?: string,
  ): Promise<boolean> {
    const result = await this.db
      .getRepository(ConversationRunQueueEntity)
      .createQueryBuilder()
      .update(ConversationRunQueueEntity)
      .set({
        status,
        finishedAt: new Date(),
        ...(error ? { error } : {}),
      })
      .where('run_id = :runId AND status = :status', { runId, status: 'started' })
      .execute()
    return (result.affected ?? 0) > 0
  }

  /**
   * 未收尾的调度项（dispatcher 启动 / 定期对账用）。
   *
   * - `dispatching` 超时且没有 runId → 重置回 queued（`recoverStale`）；
   * - 已有 runId 但 run 已经终态 → 按终态补 done/failed（防止进程在"建了 run、
   *   还没标 started / 没来得及收尾"之间被杀，队列项永远卡住）。
   */
  async listUnfinished(): Promise<ConversationRunQueueEntity[]> {
    return this.db.getRepository(ConversationRunQueueEntity).find({
      where: { status: In(['dispatching', 'started']) },
      order: { createdAt: 'ASC' },
      take: 200,
    })
  }
}
