import { Column, Entity, Unique } from 'typeorm'
import { BaseEntity } from '@repo/kits'

const bigintTransformer = {
  to: (value: number): number => value,
  from: (value: string | null): number => (value === null ? 0 : Number(value)),
}

/** AI 每日用量维度表：按模型 / agent / 工具分桶，回答「谁用的 / 哪个工具拖后腿」 */
@Entity('ai_usage_daily_dimension')
@Unique('uk_ai_usage_dimension', ['statDate', 'dimensionType', 'dimensionKey'])
export class AiUsageDailyDimensionEntity extends BaseEntity {
  @Column({ name: 'stat_date', type: 'date' })
  statDate!: string

  /** model / agent / tool */
  @Column({ name: 'dimension_type', type: 'varchar', length: 16 })
  dimensionType!: string

  @Column({ name: 'dimension_key', type: 'varchar', length: 128 })
  dimensionKey!: string

  @Column({ name: 'conversations', type: 'int', default: 0 })
  conversations = 0

  @Column({ name: 'runs', type: 'int', default: 0 })
  runs = 0

  @Column({ name: 'succeeded', type: 'int', default: 0 })
  succeeded = 0

  @Column({ name: 'failed', type: 'int', default: 0 })
  failed = 0

  @Column({ name: 'total_tokens', type: 'bigint', default: 0, transformer: bigintTransformer })
  totalTokens = 0

  @Column({ name: 'input_tokens', type: 'bigint', default: 0, transformer: bigintTransformer })
  inputTokens = 0

  @Column({ name: 'output_tokens', type: 'bigint', default: 0, transformer: bigintTransformer })
  outputTokens = 0

  @Column({ name: 'calls', type: 'int', default: 0 })
  calls = 0

  @Column({ name: 'tool_succeeded', type: 'int', default: 0 })
  toolSucceeded = 0

  @Column({ name: 'tool_failed', type: 'int', default: 0 })
  toolFailed = 0

  @Column({ name: 'tool_denied', type: 'int', default: 0 })
  toolDenied = 0

  @Column({ name: 'tool_invalid', type: 'int', default: 0 })
  toolInvalid = 0

  @Column({ name: 'tool_unknown', type: 'int', default: 0 })
  toolUnknown = 0

  @Column({ name: 'tool_no_result', type: 'int', default: 0 })
  toolNoResult = 0

  @Column({ name: 'duration_ms', type: 'bigint', default: 0, transformer: bigintTransformer })
  durationMs = 0

  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null = null
}
