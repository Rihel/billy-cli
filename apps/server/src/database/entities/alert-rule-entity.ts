import { Column, Entity, Index, Unique } from 'typeorm'
import { BaseEntity } from '@repo/kits'

/**
 * 告警规则表：admin 后台可 CRUD 配置（业务告警 + 技术告警）。
 * 匹配模型：type（tech/business）+ matchCodes（错误码，空=全部）+ keywords（消息关键字，空=不限）+ level。
 */
@Entity('alert_rules')
@Unique('uk_alert_rule_name', ['name', 'deletedAt'])
@Index('idx_alert_rule_type', ['type'])
export class AlertRuleEntity extends BaseEntity {
  /** 规则名称（语义化，唯一） */
  @Column({ name: 'name', type: 'varchar', length: 50 })
  name!: string

  /** 规则类型：tech 技术告警 / business 业务告警 */
  @Column({ name: 'type', type: 'varchar', length: 20 })
  type!: string

  /** 匹配错误码（AppErrorCodes 数字码，jsonb number[]）；空数组 = 匹配该类型全部错误 */
  @Column({ name: 'match_codes', type: 'jsonb' })
  matchCodes: number[] = []

  /** 匹配消息关键字（任一命中即匹配）；空数组 = 不限制 */
  @Column({ name: 'keywords', type: 'simple-array' })
  keywords: string[] = []

  /** 事件规则触发阈值：窗口内出现次数 ≥ threshold 才告警（默认 1 = 出现即告警） */
  @Column({ name: 'threshold', type: 'int', default: 1 })
  threshold = 1

  /** 事件规则统计窗口（秒） */
  @Column({ name: 'threshold_window_seconds', type: 'int', default: 60 })
  thresholdWindowSeconds = 60

  /** 指标名（metric / surge 规则），如 request.errorRate / request.p99 / inventory.available */
  @Column({ name: 'metric', type: 'varchar', length: 100, nullable: true })
  metric: string | null = null

  /** 比较符（metric / surge 规则）：gt / gte / lt / lte */
  @Column({ name: 'operator', type: 'varchar', length: 10, nullable: true })
  operator: string | null = null

  /** 阈值（metric 规则：指标值；surge 规则：环比倍率） */
  @Column({ name: 'threshold_value', type: 'float8', nullable: true })
  thresholdValue: number | null = null

  /** 评估周期（秒，metric / surge 规则） */
  @Column({ name: 'period_seconds', type: 'int', default: 60 })
  periodSeconds = 60

  /** 告警级别：warn / error（error 级规则同时捕获 warn 错误） */
  @Column({ name: 'level', type: 'varchar', length: 10, default: 'error' })
  level = 'error'

  /** 发送通道（simple-array）：lark / email，至少一个 */
  @Column({ name: 'channels', type: 'simple-array' })
  channels: string[] = []

  /** 限频窗口秒：同一规则 + 相同内容在窗口内只发一次（防告警风暴） */
  @Column({ name: 'throttle_seconds', type: 'int', default: 60 })
  throttleSeconds = 60

  /** 是否启用 */
  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled = true
}
