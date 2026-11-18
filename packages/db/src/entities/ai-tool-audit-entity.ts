import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

/**
 * 工具调用审计（capability-gateway 写，管理端 / 排障读）。
 *
 * 只记调用事实与结论，不记入参/出参全文（全文在 timelines）。
 */
@Entity('ai_tool_audit')
@Index('idx_ai_tool_audit_run', ['runId', 'createdAt'])
@Index('idx_ai_tool_audit_conversation', ['conversationId', 'createdAt'])
@Index('idx_ai_tool_audit_tool', ['toolKey', 'createdAt'])
export class AiToolAuditEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string

  @Column({ name: 'request_id', type: 'varchar', length: 128 })
  requestId!: string

  @Column({ name: 'run_id', type: 'varchar', length: 32 })
  runId!: string

  @Column({ name: 'conversation_id', type: 'varchar', length: 32 })
  conversationId!: string

  @Column({ name: 'user_id', type: 'varchar', length: 32, nullable: true })
  userId!: string | null

  @Column({ name: 'tool_key', type: 'varchar', length: 128 })
  toolKey!: string

  @Column({ name: 'tool_call_id', type: 'varchar', length: 128, nullable: true })
  toolCallId!: string | null

  @Column({ name: 'worker_id', type: 'varchar', length: 128 })
  workerId!: string

  @Column({ type: 'varchar', length: 16 })
  status!: string

  @Column({ type: 'varchar', length: 128, nullable: true })
  reason!: string | null

  @Column({ name: 'duration_ms', type: 'int', default: 0 })
  durationMs!: number

  @Column({ name: 'created_at', type: 'timestamp', default: () => 'now()' })
  createdAt!: Date
}
