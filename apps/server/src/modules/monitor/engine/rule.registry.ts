import { Inject, Injectable } from '@nestjs/common'
import { SYSTEM_RULES } from '../rules/index.js'
import type { MetricRegistry } from './metric.registry.js'
import type { RuleType } from '../definitions/rule.types.js'

/**
 * 规则注册表：只登记代码定义的规则类型；实例配置在 monitor_rules。
 * 启动时校验 key 唯一、指标存在、周期一致、默认配置合法。
 */
@Injectable()
export class RuleRegistry {
  private readonly rules = new Map<string, RuleType>()

  constructor() {
    this.registerRules(SYSTEM_RULES)
  }

  registerRules(rules: readonly RuleType[]): void {
    for (const rule of rules) {
      if (this.rules.has(rule.key)) {
        throw new Error(`规则 key 重复：${rule.key}`)
      }
      this.rules.set(rule.key, rule)
    }
  }

  get(key: string): RuleType | undefined {
    return this.rules.get(key)
  }

  all(): RuleType[] {
    return [...this.rules.values()]
  }

  forInterval(intervalSeconds: number): RuleType[] {
    return this.all().filter(
      (rule) => rule.evaluationIntervalSeconds === intervalSeconds,
    )
  }

  intervals(): number[] {
    return [...new Set(this.all().map((rule) => rule.evaluationIntervalSeconds))].sort(
      (a, b) => a - b,
    )
  }

  validate(metrics: MetricRegistry): void {
    for (const rule of this.rules.values()) {
      if (rule.evaluationIntervalSeconds <= 0 || rule.windowSeconds <= 0) {
        throw new Error(`规则 ${rule.key} 的周期/窗口必须为正`)
      }
      if (rule.kind === 'metric') {
        const metric = metrics.get(rule.metricKey)
        if (!metric) {
          throw new Error(`规则 ${rule.key} 引用了不存在的指标：${rule.metricKey}`)
        }
        if (metric.evaluationIntervalSeconds !== rule.evaluationIntervalSeconds) {
          throw new Error(
            `规则 ${rule.key} 的评估周期与指标 ${metric.key} 不一致`,
          )
        }
        if (metric.windowSeconds !== rule.windowSeconds) {
          throw new Error(`规则 ${rule.key} 的统计窗口与指标 ${metric.key} 不一致`)
        }
        if (metric.scope === 'global' && rule.instanceMode !== 'aggregate') {
          throw new Error(`全局指标 ${metric.key} 的规则只能是 aggregate`)
        }
      }

      const parsed = rule.paramsSchema.safeParse(rule.defaults)
      if (!parsed.success) {
        throw new Error(
          `规则 ${rule.key} 的默认配置不合法：${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
            .join('; ')}`,
        )
      }
      if (rule.defaults.channels.length === 0) {
        throw new Error(`规则 ${rule.key} 至少需要一个通知通道`)
      }
      if (rule.defaults.recoverAfterWindows < 1) {
        throw new Error(`规则 ${rule.key} 的 recoverAfterWindows 必须为正`)
      }
    }
  }
}
