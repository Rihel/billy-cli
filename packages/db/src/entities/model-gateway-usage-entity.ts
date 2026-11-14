import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

const bigintTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null => (value === null ? null : Number(value)),
}

const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null => (value === null ? null : Number(value)),
}

/**
 * **模型网关的逐请求流水**（`model_gateway_usage`）。
 *
 * 与 `runs.usage` / `ai_usage_daily` 的分工：
 * - `runs.usage` 是**业务口径**（一轮 run 的消耗，子 agent 已并入父 run）；
 * - 本表是**调用口径**：每次真实上游调用一行（含重试、标题/记忆抽取等非 run 调用），
 *   带 key / 价格快照 / 成本，用于对账与计费。
 *
 * 口径同 `usage.ts`：**字段可空，不编造 0**（缺 usage 就是 null + `usage_missing`）。
 */
@Entity('model_gateway_usage')
@Index('idx_gateway_usage_created_at', ['createdAt'])
@Index('idx_gateway_usage_run', ['runId'])
@Index('idx_gateway_usage_model', ['modelId'])
@Index('idx_gateway_usage_request', ['requestId'])
export class ModelGatewayUsageEntity extends BaseEntity {
  /** 同一次调用（含重试）共用一个 request_id；每行是其中一次尝试 */
  @Column({ name: 'request_id', type: 'varchar', length: 32 })
  requestId!: string

  /** 第几次上游尝试（1 起） */
  @Column({ name: 'attempt', type: 'int', default: 1 })
  attempt = 1

  /** 归因（来自 runtime 的 `x-billy-*` 头；非 run 调用可空） */
  @Column({ name: 'run_id', type: 'varchar', length: 20, nullable: true })
  runId: string | null = null

  @Column({ name: 'conversation_id', type: 'varchar', length: 20, nullable: true })
  conversationId: string | null = null

  @Column({ name: 'identity_type', type: 'varchar', length: 8, nullable: true })
  identityType: string | null = null

  @Column({ name: 'identity_id', type: 'varchar', length: 20, nullable: true })
  identityId: string | null = null

  @Column({ name: 'provider_id', type: 'varchar', length: 20, nullable: true })
  providerId: string | null = null

  @Column({ name: 'model_id', type: 'varchar', length: 20, nullable: true })
  modelId: string | null = null

  /** 实际使用的上游 key（key 池行 id；回落供应商 api_key 时为 null） */
  @Column({ name: 'key_id', type: 'varchar', length: 20, nullable: true })
  keyId: string | null = null

  @Column({ name: 'stream', type: 'boolean', default: false })
  stream = false

  /** success / error / aborted / rejected */
  @Column({ name: 'status', type: 'varchar', length: 8 })
  status = 'success'

  @Column({ name: 'http_status', type: 'int', nullable: true })
  httpStatus: number | null = null

  @Column({ name: 'error_code', type: 'int', nullable: true })
  errorCode: number | null = null

  /** token / image / second */
  @Column({ name: 'unit_type', type: 'varchar', length: 8, default: 'token' })
  unitType = 'token'

  @Column({ name: 'input_tokens', type: 'bigint', nullable: true, transformer: bigintTransformer })
  inputTokens: number | null = null

  @Column({ name: 'output_tokens', type: 'bigint', nullable: true, transformer: bigintTransformer })
  outputTokens: number | null = null

  @Column({ name: 'total_tokens', type: 'bigint', nullable: true, transformer: bigintTransformer })
  totalTokens: number | null = null

  @Column({
    name: 'cache_read_tokens',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  cacheReadTokens: number | null = null

  @Column({
    name: 'cache_write_tokens',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  cacheWriteTokens: number | null = null

  @Column({
    name: 'reasoning_tokens',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  reasoningTokens: number | null = null

  /** 生图张数 / 视频秒数（token 调用为 null） */
  @Column({
    name: 'units',
    type: 'numeric',
    precision: 12,
    scale: 4,
    nullable: true,
    transformer: numericTransformer,
  })
  units: number | null = null

  /** 成本（微元；未知价格 → null） */
  @Column({ name: 'cost_micros', type: 'bigint', nullable: true, transformer: bigintTransformer })
  costMicros: number | null = null

  /** 计算时用的单价快照（jsonb；不依赖价格版本表） */
  @Column({ name: 'price_snapshot', type: 'jsonb', nullable: true })
  priceSnapshot: Record<string, unknown> | null = null

  @Column({ name: 'ttft_ms', type: 'int', nullable: true })
  ttftMs: number | null = null

  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs: number | null = null

  /** 上游没返回 usage */
  @Column({ name: 'usage_missing', type: 'boolean', default: false })
  usageMissing = false
}
