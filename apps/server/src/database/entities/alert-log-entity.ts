import { Column, Entity, Index } from 'typeorm'
import { BaseEntity } from '@repo/kits'

/** 告警发送记录（审计）：每次通道发送落一条，admin 后台可查。 */
@Entity('alert_logs')
@Index('idx_alert_log_alert_id', ['alertId', 'sentAt'])
@Index('idx_alert_log_sent_at', ['sentAt'])
@Index('idx_alert_log_rule_id', ['ruleId'])
export class AlertLogEntity extends BaseEntity {
  /** 指向 monitor_alerts.id；默认告警或历史数据为空 */
  @Column({ name: 'alert_id', type: 'varchar', length: 20, nullable: true })
  alertId: string | null = null

  /** 命中的规则 id（历史数据可为空） */
  @Column({ name: 'rule_id', type: 'varchar', nullable: true })
  ruleId: string | null = null

  /** 规则名 */
  @Column({ name: 'rule_name', type: 'varchar', length: 100 })
  ruleName!: string

  /** 告警标题 */
  @Column({ name: 'title', type: 'text' })
  title!: string

  /** 告警正文 */
  @Column({ name: 'message', type: 'text' })
  message!: string

  /** 发送通道：file / lark / email */
  @Column({ name: 'channel', type: 'varchar', length: 20 })
  channel!: string

  /** 发送状态：success / failed */
  @Column({ name: 'status', type: 'varchar', length: 10 })
  status!: string

  /** 发送失败原因 */
  @Column({ name: 'error', type: 'text', nullable: true })
  error: string | null = null

  /** 发送时间 */
  @Column({ name: 'sent_at', type: 'timestamptz' })
  sentAt!: Date
}
