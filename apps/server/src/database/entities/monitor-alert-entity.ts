import { Column, Entity, Index } from 'typeorm'
import { BaseEntity } from '@repo/kits'

const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null => (value === null ? null : Number(value)),
}

const bigintTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null => (value === null ? null : Number(value)),
}

/**
 * 告警记录：一条告警从首次命中到恢复的完整生命周期。
 *
 * 同一规则同一主体同时只能有一条 `firing` 记录（部分唯一索引）；
 * 恢复后再次命中会新建一条，不复用旧记录。
 */
@Entity('monitor_alerts')
@Index('uk_monitor_alert_open', ['ruleKey', 'subjectId'], {
  unique: true,
  where: `"status" = 'firing'`,
})
@Index('idx_monitor_alert_list', ['status', 'level', 'firstFiredAt'])
@Index('idx_monitor_alert_rule', ['ruleKey', 'firstFiredAt'])
export class MonitorAlertEntity extends BaseEntity {
  @Column({ name: 'rule_key', type: 'varchar', length: 100 })
  ruleKey!: string

  /** metric / event，事件规则恢复扫描用 */
  @Column({ name: 'kind', type: 'varchar', length: 8, default: 'metric' })
  kind = 'metric'

  @Column({ name: 'rule_name', type: 'varchar', length: 100 })
  ruleName!: string

  /** warn / error / critical */
  @Column({ name: 'level', type: 'varchar', length: 10 })
  level!: string

  /** 实例 / 模型 / 工具 / 错误码 */
  @Column({ name: 'subject_id', type: 'varchar', length: 128 })
  subjectId!: string

  /** 执行评估的实例；被监控实例看 subjectId */
  @Column({ name: 'instance_id', type: 'varchar', length: 64, default: '' })
  instanceId = ''

  /** firing / resolved */
  @Column({ name: 'status', type: 'varchar', length: 12, default: 'firing' })
  status = 'firing'

  @Column({ name: 'first_fired_at', type: 'timestamptz' })
  firstFiredAt!: Date

  @Column({ name: 'last_fired_at', type: 'timestamptz' })
  lastFiredAt!: Date

  @Column({ name: 'recovered_at', type: 'timestamptz', nullable: true })
  recoveredAt: Date | null = null

  /** 恢复时写入；firing 时为空，查询时用 now - firstFiredAt */
  @Column({
    name: 'duration_ms',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  durationMs: number | null = null

  /** 连续未命中轮数，用于判定恢复 */
  @Column({ name: 'miss_count', type: 'int', default: 0 })
  missCount = 0

  @Column({
    name: 'value',
    type: 'numeric',
    precision: 20,
    scale: 4,
    nullable: true,
    transformer: numericTransformer,
  })
  value: number | null = null

  @Column({
    name: 'threshold',
    type: 'numeric',
    precision: 20,
    scale: 4,
    nullable: true,
    transformer: numericTransformer,
  })
  threshold: number | null = null

  @Column({ name: 'window_key', type: 'varchar', length: 64, nullable: true })
  windowKey: string | null = null

  @Column({ name: 'first_snapshot', type: 'jsonb', nullable: true })
  firstSnapshot: Record<string, unknown> | null = null

  @Column({ name: 'last_snapshot', type: 'jsonb', nullable: true })
  lastSnapshot: Record<string, unknown> | null = null
}
