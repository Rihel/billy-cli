import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import {
  MonitorRuleConfigSchema,
  type ListMonitorRuleDto,
  type MonitorRuleConfig,
  type MonitorRuleDefinitionModel,
  type MonitorRuleModel,
  type ResetMonitorRuleDto,
  type UpdateMonitorRuleDto,
} from '@repo/shared'
import type { MonitorRuleEntity } from '../../../database/entities/monitor-rule-entity.js'
import { definitionVersion } from '../definitions/version.js'
import { AlertLifecycleService } from '../engine/alert-lifecycle.service.js'
import { AlertRepository } from '../engine/alert.repository.js'
import { MonitorRuleRepository } from '../engine/monitor-rule.repository.js'
import { RuleRegistry } from '../engine/rule.registry.js'
import { MonitorRuleConfigInvalidError, MonitorRuleNotFoundError } from '../errors.js'

const BASE_CONFIG_KEYS = new Set([
  'enabled',
  'operator',
  'threshold',
  'channels',
  'silenceSeconds',
  'level',
  'recoverAfterWindows',
  'notifyOnRecovery',
  'streakWindows',
  'dimensionType',
  'dimensionKey',
  'matchCodes',
  'keywords',
])

/** 规则配置读模型 + 编辑用例 */
@Injectable()
export class MonitorRuleService {
  constructor(
    @Inject(RuleRegistry) private readonly rules: RuleRegistry,
    @Inject(MonitorRuleRepository) private readonly rows: MonitorRuleRepository,
    @Inject(AlertRepository) private readonly alerts: AlertRepository,
    @Inject(AlertLifecycleService) private readonly lifecycle: AlertLifecycleService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  definitions(): MonitorRuleDefinitionModel[] {
    return this.rules.all().map((rule) => ({
      key: rule.key,
      name: rule.name,
      description: rule.description,
      category: rule.category,
      kind: rule.kind,
      driver: rule.driver,
      metricKey: rule.kind === 'metric' ? rule.metricKey : null,
      evaluationIntervalSeconds: rule.evaluationIntervalSeconds,
      windowSeconds: rule.windowSeconds,
      defaults: rule.defaults,
      fields: rule.fields,
      definitionVersion: definitionVersion(rule),
    }))
  }

  async list(query: ListMonitorRuleDto): Promise<MonitorRuleModel[]> {
    const rows = await this.rows.findAll()
    const keyword = query.keyword?.trim().toLowerCase()
    return Promise.all(
      rows
        .filter((row) => !query.category || row.category === query.category)
        .filter(
          (row) =>
            !keyword ||
            row.name.toLowerCase().includes(keyword) ||
            row.ruleKey.toLowerCase().includes(keyword),
        )
        .map(async (row) => this.toModel(row)),
    )
  }

  async update(input: UpdateMonitorRuleDto): Promise<MonitorRuleModel> {
    const definition = this.rules.get(input.ruleKey)
    if (!definition) throw new MonitorRuleNotFoundError(input.ruleKey)
    const row = await this.rows.findByKey(input.ruleKey)
    if (!row) throw new MonitorRuleNotFoundError(input.ruleKey)

    const allowed = new Set([...BASE_CONFIG_KEYS, ...definition.fields.map((field) => field.key)])
    for (const key of Object.keys(input.config ?? {})) {
      if (!allowed.has(key)) {
        throw new MonitorRuleConfigInvalidError(`不支持的配置字段：${key}`)
      }
    }

    const current = this.readConfig(definition.defaults, row)
    const enabled = input.enabled ?? row.enabled
    const parsed = MonitorRuleConfigSchema.safeParse({
      ...current,
      ...input.config,
      enabled,
    })
    if (!parsed.success) {
      throw new MonitorRuleConfigInvalidError(
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
          .join('; '),
      )
    }

    const updated = await this.rows.updateConfig(input.ruleKey, parsed.data, enabled)
    if (!updated) throw new MonitorRuleNotFoundError(input.ruleKey)
    if (!enabled) {
      await this.lifecycle.resolveByRule(input.ruleKey, new Date())
    }
    this.logger.log('monitor.rule.updated', { ruleKey: input.ruleKey, enabled })
    return this.toModel(updated)
  }

  async reset(input: ResetMonitorRuleDto): Promise<MonitorRuleModel> {
    const definition = this.rules.get(input.ruleKey)
    if (!definition) throw new MonitorRuleNotFoundError(input.ruleKey)
    const row = await this.rows.findByKey(input.ruleKey)
    if (!row) throw new MonitorRuleNotFoundError(input.ruleKey)

    const config: MonitorRuleConfig = {
      ...definition.defaults,
      enabled: row.enabled,
    }
    const updated = await this.rows.updateConfig(input.ruleKey, config, row.enabled)
    if (!updated) throw new MonitorRuleNotFoundError(input.ruleKey)
    return this.toModel(updated)
  }

  private async toModel(row: MonitorRuleEntity): Promise<MonitorRuleModel> {
    const definition = this.rules.get(row.ruleKey)
    const config = definition
      ? this.readConfig(definition.defaults, row)
      : (row.config as MonitorRuleConfig)
    return {
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ruleKey: row.ruleKey,
      name: row.name,
      description: row.description,
      category: row.category as MonitorRuleModel['category'],
      kind: row.kind as MonitorRuleModel['kind'],
      driver: row.driver as MonitorRuleModel['driver'],
      metricKey: row.metricKey,
      evaluationIntervalSeconds: row.evaluationIntervalSeconds,
      windowSeconds: row.windowSeconds,
      config,
      definitionVersion: row.definitionVersion,
      enabled: row.enabled,
      deprecated: row.deprecated,
      lastFiredAt: await this.alerts.lastFiredAt(row.ruleKey),
    }
  }

  private readConfig(defaults: MonitorRuleConfig, row: MonitorRuleEntity): MonitorRuleConfig {
    const parsed = MonitorRuleConfigSchema.safeParse({ ...defaults, ...row.config })
    if (!parsed.success) {
      this.logger.warn('monitor.rule.config_invalid', {
        ruleKey: row.ruleKey,
        issues: parsed.error.issues,
      })
      return defaults
    }
    return parsed.data
  }
}
