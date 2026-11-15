import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

/**
 * 父会话的 root run 队列（异步子 agent 的唤醒也走这里）。
 *
 * 与 `runs` 的分工：
 * - `runs` 是**已经开始的执行**（审计证据）；
 * - 本表是**还没开始的调度意图**：用户消息 / 子 agent 完成唤醒；
 * - 同一会话同一时刻只允许一个 root run，由 `runs` 的部分唯一索引兜底；
 *   本表按 `priority, created_at` 串行取队首。
 *
 * 它不是业务正文：`payload` 只放启动 run 所需的最小数据；队列项 done/canceled 后可清理。
 */
@Entity('conversation_run_queue')
@Index('idx_run_queue_dispatch', ['conversationId', 'status', 'priority', 'createdAt'])
@Index('uk_run_queue_dedupe', ['dedupeKey'], {
  unique: true,
  where: 'dedupe_key IS NOT NULL',
})
export class ConversationRunQueueEntity extends BaseEntity {
  /** 根会话 id */
  @Column({ name: 'conversation_id', type: 'varchar', length: 20 })
  conversationId!: string

  /** user（用户消息） / subagent（子 agent 完成唤醒） */
  @Column({ name: 'source', type: 'varchar', length: 16 })
  source!: string

  /** user=0，subagent=1；越小越先 */
  @Column({ name: 'priority', type: 'smallint' })
  priority = 1

  /** queued / dispatching / started / done / canceled / failed */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'queued' })
  status = 'queued'

  /** 幂等键：子 agent 完成用 subRunId；用户消息可空 */
  @Column({ name: 'dedupe_key', type: 'varchar', length: 80, nullable: true })
  dedupeKey: string | null = null

  /** 启动 run 所需的数据（用户消息 / 子 agent 结果） */
  @Column({ name: 'payload', type: 'jsonb' })
  payload!: Record<string, unknown>

  /** 实际创建出来的 root run */
  @Column({ name: 'run_id', type: 'varchar', length: 20, nullable: true })
  runId: string | null = null

  @Column({ name: 'error', type: 'text', nullable: true })
  error: string | null = null

  @Column({ name: 'started_at', type: 'timestamp', precision: 3, nullable: true })
  startedAt: Date | null = null

  @Column({ name: 'finished_at', type: 'timestamp', precision: 3, nullable: true })
  finishedAt: Date | null = null
}
