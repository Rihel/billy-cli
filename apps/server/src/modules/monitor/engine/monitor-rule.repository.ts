import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import { In, type QueryDeepPartialEntity } from 'typeorm'
import { MonitorRuleEntity } from '../../../database/entities/monitor-rule-entity.js'
import type { MonitorRuleConfig } from '@repo/shared'
import type { RuleType } from '../definitions/rule.types.js'

/** 规则实例仓储：只做 monitor_rules 的读写 */
@Injectable()
export class MonitorRuleRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(MonitorRuleEntity)
  }

  async findByKey(ruleKey: string, withDeleted = false): Promise<MonitorRuleEntity | null> {
    const repo = await this.repo()
    return repo.findOne({
      where: { ruleKey },
      withDeleted,
    })
  }

  async findAll(withDeleted = false): Promise<MonitorRuleEntity[]> {
    const repo = await this.repo()
    return repo.find({
      withDeleted,
      order: { category: 'ASC', name: 'ASC' },
    })
  }

  async findEnabledByInterval(intervalSeconds: number): Promise<MonitorRuleEntity[]> {
    const repo = await this.repo()
    return repo.find({
      where: { enabled: true, deprecated: false, evaluationIntervalSeconds: intervalSeconds },
    })
  }

  async findEnabledByKind(kind: 'metric' | 'event'): Promise<MonitorRuleEntity[]> {
    const repo = await this.repo()
    return repo.find({
      where: { enabled: true, deprecated: false, kind },
    })
  }

  async createFromDefinition(definition: RuleType, definitionVersion: string): Promise<MonitorRuleEntity> {
    const repo = await this.repo()
    return repo.save(
      repo.create({
        ruleKey: definition.key,
        name: definition.name,
        description: definition.description,
        category: definition.category,
        kind: definition.kind,
        driver: definition.driver,
        metricKey: definition.kind === 'metric' ? definition.metricKey : null,
        evaluationIntervalSeconds: definition.evaluationIntervalSeconds,
        windowSeconds: definition.windowSeconds,
        source: 'code',
        config: definition.defaults as unknown as Record<string, unknown>,
        definitionVersion,
        enabled: definition.defaults.enabled,
        deprecated: false,
      }),
    )
  }

  async updateMetadata(definition: RuleType, definitionVersion: string): Promise<void> {
    const repo = await this.repo()
    await repo.update(
      { ruleKey: definition.key },
      {
        name: definition.name,
        description: definition.description,
        category: definition.category,
        kind: definition.kind,
        driver: definition.driver,
        metricKey: definition.kind === 'metric' ? definition.metricKey : null,
        evaluationIntervalSeconds: definition.evaluationIntervalSeconds,
        windowSeconds: definition.windowSeconds,
        definitionVersion,
        deprecated: false,
      },
    )
  }

  async updateConfig(
    ruleKey: string,
    config: MonitorRuleConfig,
    enabled?: boolean,
  ): Promise<MonitorRuleEntity | null> {
    const repo = await this.repo()
    const patch: Partial<MonitorRuleEntity> = { config: config as unknown as Record<string, unknown> }
    if (enabled !== undefined) patch.enabled = enabled
    await repo.update({ ruleKey }, patch as QueryDeepPartialEntity<MonitorRuleEntity>)
    return this.findByKey(ruleKey)
  }

  async deprecateMissing(keys: readonly string[]): Promise<MonitorRuleEntity[]> {
    const repo = await this.repo()
    const all = await repo.find({ where: { source: 'code' } })
    const missing = all.filter((row) => !keys.includes(row.ruleKey))
    if (missing.length === 0) return []
    await repo.update({ id: In(missing.map((row) => row.id)) }, { deprecated: true, enabled: false })
    return missing
  }

  async restore(id: string): Promise<void> {
    const repo = await this.repo()
    await repo.restore(id)
  }
}
