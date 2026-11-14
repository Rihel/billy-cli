import { AuditEntity } from '@repo/kits'
import { TimelineRole } from '@repo/shared'
import { Column, Entity, Index } from 'typeorm'

/**
 * 时间线：会话里按顺序发生的事（**一行一个 part / 事件**）。
 *
 * 为什么细到 part 而不是一行一条消息：推理过程、工具调用与结果本身就是独立事件；
 * 而且**运行中可以增量落库**（每个 part 完成即写一行），不必等整条消息结束。
 *
 * 两条硬规则（见设计文档 §4.6）：
 * 1. **只追加**，不提供改 / 删（审计证据；唯一的"改"是崩溃恢复重跑时的 upsert）；
 * 2. **不裁剪**：工具入参出参、摘要正文都完整保存。
 */
@Entity('timelines')
@Index('idx_timeline_conversation_seq', ['conversationId', 'seq'])
@Index('idx_timeline_run_seq', ['runId', 'seq'])
@Index('idx_timeline_message', ['messageId'])
@Index('idx_timeline_tool', ['toolKey'])
// 崩溃恢复重跑会重新产出同一次工具调用 → 靠这个唯一约束 upsert，避免时间线出现两条一样的工具调用。
// **必须带 kind**：同一次调用会落两行（tool-call 与 tool-result），二者共用 tool_call_id。
@Index('uk_timeline_tool_call', ['runId', 'toolCallId', 'kind'], {
  unique: true,
  where: 'tool_call_id IS NOT NULL',
})
// 工具结果分页的**回取**路径：按 (会话, toolCallId) 找原文（设计 §5.6）
@Index('idx_timeline_conversation_tool_call', ['conversationId', 'toolCallId'], {
  where: 'tool_call_id IS NOT NULL',
})
// 组装上下文时快速定位「最新一条摘要」
@Index('idx_timeline_summary', ['conversationId', 'seq'], { where: "kind = 'summary'" })
export class TimelineEntity extends AuditEntity {
  /** 所属会话 */
  @Column({ name: 'conversation_id', type: 'varchar', length: 20 })
  conversationId!: string

  /** 属于哪一轮（用户消息也归属触发它的那一轮） */
  @Column({ name: 'run_id', type: 'varchar', length: 20, nullable: true })
  runId: string | null = null

  /** 同一条消息的多个 part 共享（= AI SDK 的 message id） */
  @Column({ name: 'message_id', type: 'varchar', length: 64, default: '' })
  messageId = ''

  /** 会话内单调递增的序号（**渲染顺序的权威依据**，不依赖时间戳） */
  @Column({ name: 'seq', type: 'int' })
  seq!: number

  /** 第几次尝试（崩溃恢复重跑时 +1） */
  @Column({ name: 'attempt', type: 'int', default: 1 })
  attempt = 1

  /** 角色：见 TimelineRole 字典（system / user / assistant） */
  @Column({ name: 'role', type: 'varchar', length: 20 })
  role: string = TimelineRole.Assistant

  /** 事件类型：见 TimelineKind 字典（text / reasoning / tool-call / tool-result / step / summary …） */
  @Column({ name: 'kind', type: 'varchar', length: 32 })
  kind!: string

  /** 对齐 AI SDK part 的状态（streaming / done / error；工具另有七态），可为空 */
  @Column({ name: 'state', type: 'varchar', length: 20, nullable: true })
  state: string | null = null

  /** 工具行专用：工具 key（提为列便于直接查"哪个工具最慢 / 最常失败"） */
  @Column({ name: 'tool_key', type: 'varchar', length: 64, nullable: true })
  toolKey: string | null = null

  /** 工具行专用：本次工具调用 id（配对 tool-call 与 tool-result，也是幂等键的一半） */
  @Column({ name: 'tool_call_id', type: 'varchar', length: 64, nullable: true })
  toolCallId: string | null = null

  /** 事件的真实开始时间（**不等于 created_at**：我们是 part 完成时才落库的） */
  @Column({ name: 'started_at', type: 'timestamp', precision: 3, nullable: true })
  startedAt: Date | null = null

  /** 事件的结束时间；为空表示仍在进行 */
  @Column({ name: 'finished_at', type: 'timestamp', precision: 3, nullable: true })
  finishedAt: Date | null = null

  /** 耗时（ms）：文本行是生成耗时、工具行是执行耗时、step 行是该步总耗时 */
  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs: number | null = null

  /** 该事件的用量（step 行放这一步的 token；摘要行放生成摘要的花费） */
  @Column({ name: 'usage', type: 'jsonb', nullable: true })
  usage: Record<string, unknown> | null = null

  /** 事件原文（文本 / 工具入参 / 工具出参 / 摘要正文与元信息 / 错误），**一律不裁剪** */
  @Column({ name: 'payload', type: 'jsonb', nullable: true })
  payload: Record<string, unknown> | null = null
}
