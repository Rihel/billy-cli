import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

/**
 * **每代派发一行**：`ai_tool_effects` 是「当前状态」，这张表是「历史事实」。
 *
 * 为什么不能只留一张表：重派发会把 `ai_tool_effects` 的 `outcome` / `settled_at` 清空
 * （新的一代开始了），上一代的迟到归档结论就会被抹掉 —— 而「第一代到底有没有执行」正是
 * 出事时最需要回答的问题。按代留行，迟到结论、重试、unknown 才能互不覆盖。
 *
 * 口径：
 * - `(effect_id, generation)` 唯一，`generation` 与主表的 `attempts` 同源；
 * - 只追加与更新本代自身的结算，不删除（历史是证据）；
 * - `task_id` 与结算结论**分开记**：旧代即使结算被判 `stale`，任务号照样要留（停止时靠它兜底取消）。
 */
@Entity('ai_tool_effect_attempts')
@Index('uk_ai_tool_effect_attempt_gen', ['effectId', 'generation'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
@Index('idx_ai_tool_effect_attempt_run', ['runId', 'updatedAt'])
export class AiToolEffectAttemptEntity extends BaseEntity {
  /** 主表 `ai_tool_effects.id` */
  @Column({ name: 'effect_id', type: 'varchar', length: 20 })
  effectId!: string

  @Column({ name: 'run_id', type: 'varchar', length: 32 })
  runId!: string

  @Column({ name: 'tool_call_id', type: 'varchar', length: 128 })
  toolCallId!: string

  @Column({ type: 'varchar', length: 64 })
  capability!: string

  /** 第几次派发（= 主表 `attempts` 的当时值） */
  @Column({ type: 'int' })
  generation!: number

  /** dispatched / completed / failed / unknown */
  @Column({ type: 'varchar', length: 16 })
  status!: string

  @Column({ name: 'deadline_at', type: 'timestamp', precision: 3 })
  deadlineAt!: Date

  /** 派发时间（本代开始的那一刻） */
  @Column({ name: 'dispatched_at', type: 'timestamp', precision: 3, default: () => 'now()' })
  dispatchedAt!: Date

  @Column({ type: 'jsonb', nullable: true })
  outcome!: Record<string, unknown> | null

  @Column({ name: 'result_bytes', type: 'int', default: 0 })
  resultBytes!: number

  @Column({ name: 'task_id', type: 'varchar', length: 128, nullable: true })
  taskId!: string | null

  @Column({ name: 'settled_at', type: 'timestamp', precision: 3, nullable: true })
  settledAt!: Date | null
}
