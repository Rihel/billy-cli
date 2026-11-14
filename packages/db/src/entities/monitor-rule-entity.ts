import { Column, Entity, Index, Unique } from 'typeorm'
import { BaseEntity } from '@repo/kits'

/**
 * 监控规则实例表。
 *
 * 规则是否存在由代码定义（`RuleType`）决定；这张表只保存实例配置和开关。
 * 启动时 seed 按 `rule_key` 对账，不覆盖用户改过的 `config` / `enabled`。
 */
@Entity('monitor_rules')
@Unique('uk_monitor_rule_key', ['ruleKey'])
@Index('idx_monitor_rule_category', ['category', 'enabled'])
export class MonitorRuleEntity extends BaseEntity {
  /** 代码里的稳定 key，如 system.http.error-rate */
  @Column({ name: 'rule_key', type: 'varchar', length: 100 })
  ruleKey!: string

  @Column({ name: 'name', type: 'varchar', length: 100 })
  name!: string

  @Column({ name: 'description', type: 'varchar', length: 500 })
  description!: string

  /** system / business */
  @Column({ name: 'category', type: 'varchar', length: 16 })
  category!: string

  /** metric / event */
  @Column({ name: 'kind', type: 'varchar', length: 8 })
  kind!: string

  /** batch / stream */
  @Column({ name: 'driver', type: 'varchar', length: 8, default: 'batch' })
  driver = 'batch'

  @Column({ name: 'metric_key', type: 'varchar', length: 100, nullable: true })
  metricKey: string | null = null

  @Column({ name: 'evaluation_interval_seconds', type: 'int' })
  evaluationIntervalSeconds!: number

  @Column({ name: 'window_seconds', type: 'int' })
  windowSeconds!: number

  /** code / manual（manual 预留给以后扩展，当前只写 code） */
  @Column({ name: 'source', type: 'varchar', length: 16, default: 'code' })
  source = 'code'

  /** 阈值、级别、通道、静默、恢复轮数、维度等 */
  @Column({ name: 'config', type: 'jsonb' })
  config: Record<string, unknown> = {}

  /** 代码定义哈希，用于提示「定义已更新」 */
  @Column({ name: 'definition_version', type: 'varchar', length: 64, nullable: true })
  definitionVersion: string | null = null

  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled = true

  /** 代码里已删除的规则置 true，保留历史 */
  @Column({ name: 'deprecated', type: 'boolean', default: false })
  deprecated = false
}
