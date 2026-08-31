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
