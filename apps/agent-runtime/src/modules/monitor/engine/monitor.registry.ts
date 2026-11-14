import { Inject, Injectable } from '@nestjs/common'
import { MetricRegistry } from './metric.registry.js'
import { RuleRegistry } from './rule.registry.js'
import type { MetricDefinition, MetricSource } from '../definitions/metric.types.js'
import type { RuleType } from '../definitions/rule.types.js'

/** 业务模块注册入口：指标 / 指标源 / 规则 */
export interface MonitorDefinitions {
  metrics?: readonly MetricDefinition[]
  rules?: readonly RuleType[]
  sources?: readonly MetricSource[]
}

/**
 * 监控注册总入口。业务模块 import MonitorModule 后注入它，
 * 在 onModuleInit 里注册；MonitorModule 不反向 import 业务模块。
 */
@Injectable()
export class MonitorRegistry {
  constructor(
    @Inject(MetricRegistry) private readonly metrics: MetricRegistry,
    @Inject(RuleRegistry) private readonly rules: RuleRegistry,
  ) {}

  register(definitions: MonitorDefinitions): void {
    for (const source of definitions.sources ?? []) this.metrics.registerSource(source)
    this.metrics.registerMetrics(definitions.metrics ?? [])
    this.rules.registerRules(definitions.rules ?? [])
  }

  validate(): void {
    this.metrics.validate()
    this.rules.validate(this.metrics)
  }
}
