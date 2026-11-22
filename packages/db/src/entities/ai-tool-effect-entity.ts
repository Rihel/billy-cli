import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

/**
 * **工具副作用台账**（capability-gateway 唯一写方）。
 *
 * 一行 = 一次「有身份的执行」：`(run_id, tool_call_id)` 唯一。存在的理由只有一个 ——
 * durable run 崩溃恢复会**重放同一个 toolCallId**（见 `docs/design/ai-agent.md` §3.4），
 * 没有这张表就无法判断「这个副作用到底执行过没有」，只能盲目重跑或盲目判失败。
 *
 * 状态机（`docs/design/tool-effect-ledger.md`）：
 * `dispatched`（已派发）→ `completed`（拿到成功结论）/ `failed`（拿到失败结论）；
 * 派发后超过 `deadline_at` 仍未结算 → `unknown`（**不能当作失败，也不允许无脑重跑**）。
 *
 * 口径：
 * - 入参只留哈希（`request_hash`），不留明文参数；参数全文在 timelines；
 * - 结果只在 ≤ `MAX_EFFECT_RESULT_BYTES` 时留下（`outcome` jsonb），超限只记 `result_bytes`，
 *   重放时按能力风险决定「重新执行」还是「报结果不可用」；
 * - 台账是证据，不提供删除 / 清空能力（软删列只用于唯一索引的部分条件）。
 */
@Entity('ai_tool_effects')
@Index('uk_ai_tool_effect_run_call', ['runId', 'toolCallId'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
@Index('idx_ai_tool_effect_run', ['runId', 'createdAt'])
@Index('idx_ai_tool_effect_capability', ['capability', 'createdAt'])
export class AiToolEffectEntity extends BaseEntity {
  @Column({ name: 'run_id', type: 'varchar', length: 32 })
  runId!: string

  @Column({ name: 'conversation_id', type: 'varchar', length: 32 })
  conversationId!: string

  @Column({ name: 'tool_call_id', type: 'varchar', length: 128 })
  toolCallId!: string

  @Column({ type: 'varchar', length: 64 })
  capability!: string

  /** 规范化参数的 md5：同一句柄换了参数就是「冲突」，不是重放 */
  @Column({ name: 'request_hash', type: 'varchar', length: 32 })
  requestHash!: string

  /** dispatched / completed / failed / unknown */
  @Column({ type: 'varchar', length: 16 })
  status!: string

  /** 派发次数：每次合法重试 +1，用于观测「同名调用被跑了几次」 */
  @Column({ type: 'int', default: 1 })
  attempts!: number

  /** 本次派发的结算期限：过期未结算即 unknown */
  @Column({ name: 'deadline_at', type: 'timestamp', precision: 3 })
  deadlineAt!: Date

  /** 结论快照（≤ 上限才存完整 data；超限为 null） */
  @Column({ type: 'jsonb', nullable: true })
  outcome!: Record<string, unknown> | null

  /** 结论原文大小（超限时用来解释「为什么没有结果」） */
  @Column({ name: 'result_bytes', type: 'int', default: 0 })
  resultBytes!: number

  @Column({ name: 'settled_at', type: 'timestamp', precision: 3, nullable: true })
  settledAt!: Date | null
}
