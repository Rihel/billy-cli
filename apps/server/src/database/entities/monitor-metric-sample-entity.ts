import { Column, Entity, Index, Unique } from 'typeorm'
import { BaseEntity } from '@repo/kits'

/** numeric 列在 pg 驱动里返回字符串；统一转成 number 给业务层 */
const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null => (value === null ? null : Number(value)),
}

/**
 * 指标样本（时间序列）。
 *
 * 一个窗口 + 一个实例 + 一个维度一行；raw / derived 都落这张表。
 * `window_key` 60 秒窗口用窗口起点 ISO，按天窗口用 `YYYY-MM-DD`。
 */
@Entity('monitor_metric_samples')
@Unique('uk_monitor_sample_window', [
  'metricKey',
  'windowKey',
  'instanceId',
  'dimensionType',
  'dimensionKey',
])
@Index('idx_monitor_sample_metric', ['metricKey', 'windowEnd'])
@Index('idx_monitor_sample_dimension', ['dimensionType', 'dimensionKey', 'windowEnd'])
export class MonitorMetricSampleEntity extends BaseEntity {
  /** raw / derived */
  @Column({ name: 'metric_kind', type: 'varchar', length: 8 })
  metricKind!: string

  @Column({ name: 'metric_key', type: 'varchar', length: 100 })
  metricKey!: string

  @Column({ name: 'window_key', type: 'varchar', length: 64 })
  windowKey!: string

  @Column({ name: 'window_start', type: 'timestamptz' })
  windowStart!: Date

  @Column({ name: 'window_end', type: 'timestamptz' })
  windowEnd!: Date

  /** 实例指标写实例 id；全局指标写空串（不用 NULL，避免唯一键失效） */
  @Column({ name: 'instance_id', type: 'varchar', length: 64, default: '' })
  instanceId = ''

  @Column({ name: 'dimension_type', type: 'varchar', length: 16, default: 'total' })
  dimensionType = 'total'

  @Column({ name: 'dimension_key', type: 'varchar', length: 128, default: '' })
  dimensionKey = ''

  @Column({
    name: 'value',
    type: 'numeric',
    precision: 20,
    scale: 4,
    transformer: numericTransformer,
  })
  value!: number

  @Column({ name: 'labels', type: 'jsonb', nullable: true })
  labels: Record<string, string> | null = null
}
