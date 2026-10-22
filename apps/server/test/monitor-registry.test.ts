import { describe, expect, it } from 'vitest'
import { Telemetry } from '@repo/kits'
import { MetricRegistry } from '../src/modules/monitor/engine/metric.registry.js'
import { RuleRegistry } from '../src/modules/monitor/engine/rule.registry.js'
import { ProcessSource } from '../src/modules/monitor/sources/process.source.js'
import { TelemetrySource } from '../src/modules/monitor/sources/telemetry.source.js'
import { httpErrorRateRule } from '../src/modules/monitor/rules/system/http-error-rate.rule.js'

const metricRegistry = (): MetricRegistry =>
  new MetricRegistry(new TelemetrySource(new Telemetry()), new ProcessSource())

describe('监控注册表校验', () => {
  it('系统指标 + 系统规则能通过启动校验', () => {
    const metrics = metricRegistry()
    const rules = new RuleRegistry()
    expect(() => metrics.validate()).not.toThrow()
    expect(() => rules.validate(metrics)).not.toThrow()
  })

  it('衍生指标依赖不存在时启动失败', () => {
    const metrics = metricRegistry()
    metrics.registerMetrics([
      {
        key: 'test.derived',
        title: 'test',
        description: 'test',
        category: 'system',
        unit: 'ratio',
        evaluationIntervalSeconds: 60,
        windowSeconds: 60,
        staleAfterSeconds: 120,
        scope: 'instance',
        kind: 'derived',
        dependsOn: ['test.missing'],
        derive: () => [],
      },
    ])
    expect(() => metrics.validate()).toThrow('依赖了不存在的指标')
  })

  it('规则引用不存在指标时启动失败', () => {
    const metrics = metricRegistry()
    const rules = new RuleRegistry()
    rules.registerRules([
      {
        ...httpErrorRateRule,
        key: 'test.rule',
        metricKey: 'test.missing',
      },
    ])
    expect(() => rules.validate(metrics)).toThrow('引用了不存在的指标')
  })
})
