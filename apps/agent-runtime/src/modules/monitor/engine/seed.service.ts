import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { definitionVersion } from '../definitions/version.js'
import { AlertLifecycleService } from './alert-lifecycle.service.js'
import { MonitorRuleRepository } from './monitor-rule.repository.js'
import { MonitorRegistry } from './monitor.registry.js'
import { RuleRegistry } from './rule.registry.js'

/** 启动对账：校验定义 → upsert 规则元数据 → 停用代码里已删除的规则 */
@Injectable()
export class SeedService {
  constructor(
    @Inject(MonitorRegistry) private readonly registry: MonitorRegistry,
    @Inject(RuleRegistry) private readonly rules: RuleRegistry,
    @Inject(MonitorRuleRepository) private readonly rows: MonitorRuleRepository,
    @Inject(AlertLifecycleService) private readonly lifecycle: AlertLifecycleService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async sync(): Promise<void> {
    this.registry.validate()

    const definitions = this.rules.all()
    const keys = definitions.map((rule) => rule.key)
    let inserted = 0
    let updated = 0
    let restored = 0
    const now = new Date()

    for (const definition of definitions) {
      const version = definitionVersion(definition)
      const existing = await this.rows.findByKey(definition.key, true)
      if (!existing) {
        await this.rows.createFromDefinition(definition, version)
        inserted++
        continue
      }
      if (existing.deletedAt) await this.rows.restore(existing.id)
      await this.rows.updateMetadata(definition, version)
      if (existing.deprecated) restored++
      updated++
    }

    const deprecated = await this.rows.deprecateMissing(keys)
    for (const row of deprecated) {
      await this.lifecycle.resolveByRule(row.ruleKey, now)
    }

    this.logger.log('monitor.seed.done', {
      inserted,
      updated,
      restored,
      deprecated: deprecated.length,
      total: definitions.length,
    })
  }
}
