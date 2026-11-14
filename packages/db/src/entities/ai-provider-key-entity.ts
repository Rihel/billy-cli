import { AuditEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

const bigintTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null => (value === null ? null : Number(value)),
}

/**
 * **上游供应商 key 池**（`ai_provider_keys`）。
 *
 * 一个供应商可配置多把 key；网关按权重 / 冷却 / 额度选择（运行态的 cooldown 在 Redis，
 * 不落库）。`secret` 建议后续加密（当前沿用 `ai_providers.api_key` 的明文口径）。
 */
@Entity('ai_provider_keys')
@Index('idx_provider_key_provider', ['providerId'])
@Index('idx_provider_key_status', ['status'])
export class AiProviderKeyEntity extends AuditEntity {
  @Column({ name: 'provider_id', type: 'varchar', length: 20 })
  providerId!: string

  /** 人读标签（账号 / 额度备注） */
  @Column({ name: 'label', type: 'varchar', length: 64 })
  label!: string

  @Column({ name: 'secret', type: 'text' })
  secret!: string

  /** active / disabled（disabled 需人工恢复） */
  @Column({ name: 'status', type: 'varchar', length: 8, default: 'active' })
  status = 'active'

  /** 选择权重（越大越优先；同权重按最近最少用） */
  @Column({ name: 'weight', type: 'int', default: 1 })
  weight = 1

  /** 该 key 的额度（null = 不限；rpm/tpm 为每分钟，daily* 为每日） */
  @Column({ name: 'rpm', type: 'int', nullable: true })
  rpm: number | null = null

  @Column({ name: 'tpm', type: 'int', nullable: true })
  tpm: number | null = null

  @Column({ name: 'daily_tokens', type: 'bigint', nullable: true, transformer: bigintTransformer })
  dailyTokens: number | null = null

  @Column({
    name: 'daily_cost_micros',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  dailyCostMicros: number | null = null

  @Column({ name: 'last_used_at', type: 'timestamp', precision: 3, nullable: true })
  lastUsedAt: Date | null = null

  /** 连续失败次数（401/403 用；达到阈值后由运维置 disabled） */
  @Column({ name: 'failure_count', type: 'int', default: 0 })
  failureCount = 0
}
