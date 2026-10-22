import { Column, Entity, Unique } from 'typeorm'
import { BaseEntity } from '@repo/kits'

const bigintTransformer = {
  to: (value: number): number => value,
  from: (value: string | null): number => (value === null ? 0 : Number(value)),
}

/** AI 每日用量主表：一天一行，回答「今天整体怎么样」 */
@Entity('ai_usage_daily')
@Unique('uk_ai_usage_daily_date', ['statDate'])
export class AiUsageDailyEntity extends BaseEntity {
  /** 业务日（Asia/Shanghai），YYYY-MM-DD */
  @Column({ name: 'stat_date', type: 'date' })
  statDate!: string

  @Column({ name: 'conversations', type: 'int', default: 0 })
  conversations = 0

  @Column({ name: 'new_conversations', type: 'int', default: 0 })
  newConversations = 0

  @Column({ name: 'active_users', type: 'int', default: 0 })
  activeUsers = 0

  @Column({ name: 'runs', type: 'int', default: 0 })
  runs = 0

  @Column({ name: 'succeeded', type: 'int', default: 0 })
  succeeded = 0

  @Column({ name: 'failed', type: 'int', default: 0 })
  failed = 0

  @Column({ name: 'canceled', type: 'int', default: 0 })
  canceled = 0

  @Column({ name: 'interrupted', type: 'int', default: 0 })
  interrupted = 0

  @Column({ name: 'total_tokens', type: 'bigint', default: 0, transformer: bigintTransformer })
  totalTokens = 0

  @Column({ name: 'input_tokens', type: 'bigint', default: 0, transformer: bigintTransformer })
  inputTokens = 0

  @Column({ name: 'output_tokens', type: 'bigint', default: 0, transformer: bigintTransformer })
  outputTokens = 0

  @Column({ name: 'cache_read_tokens', type: 'bigint', default: 0, transformer: bigintTransformer })
  cacheReadTokens = 0

  @Column({ name: 'cache_write_tokens', type: 'bigint', default: 0, transformer: bigintTransformer })
  cacheWriteTokens = 0

  @Column({ name: 'reasoning_tokens', type: 'bigint', default: 0, transformer: bigintTransformer })
  reasoningTokens = 0

  @Column({ name: 'steps', type: 'int', default: 0 })
  steps = 0

  @Column({ name: 'tool_calls', type: 'int', default: 0 })
  toolCalls = 0

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

  @Column({ name: 'run_duration_ms', type: 'bigint', default: 0, transformer: bigintTransformer })
  runDurationMs = 0

  @Column({ name: 'first_token_ms_sum', type: 'bigint', default: 0, transformer: bigintTransformer })
  firstTokenMsSum = 0

  @Column({ name: 'first_token_runs', type: 'int', default: 0 })
  firstTokenRuns = 0

  @Column({ name: 'usage_missing_runs', type: 'int', default: 0 })
  usageMissingRuns = 0

  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null = null
}
