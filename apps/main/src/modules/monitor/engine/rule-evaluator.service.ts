import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { MonitorRuleConfigSchema, type MonitorRuleConfig } from '@repo/shared'
import type { MetricDefinition, MetricSample, MetricWindow } from '../definitions/metric.types.js'
import type { MetricRuleType, RuleSubject, RuleType } from '../definitions/rule.types.js'
import { aggregate } from '../definitions/aggregate.js'
import { AlertDeliveryService } from './alert-delivery.service.js'
import { AlertLifecycleService } from './alert-lifecycle.service.js'
import { MetricRegistry } from './metric.registry.js'
import { MetricSampleRepository } from './metric-sample.repository.js'
import { MonitorInstanceService } from './instance.service.js'
import { MonitorRuleRepository } from './monitor-rule.repository.js'
import { StaleGuard } from './stale.guard.js'
import { StreamStateService } from './stream-state.service.js'

/** 单个规则的一次评估：取样本 → 归并主体 → match → 告警记录 → 投递 */
@Injectable()
export class RuleEvaluatorService {
  private readonly lastEvaluated = new Map<string, Date>()

  constructor(
    @Inject(MetricRegistry) private readonly metrics: MetricRegistry,
    @Inject(MonitorRuleRepository) private readonly ruleRows: MonitorRuleRepository,
    @Inject(MetricSampleRepository) private readonly samples: MetricSampleRepository,
    @Inject(StaleGuard) private readonly staleGuard: StaleGuard,
    @Inject(StreamStateService) private readonly streamState: StreamStateService,
    @Inject(AlertLifecycleService) private readonly lifecycle: AlertLifecycleService,
    @Inject(AlertDeliveryService) private readonly delivery: AlertDeliveryService,
    @Inject(MonitorInstanceService) private readonly instance: MonitorInstanceService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  lastEvaluatedAt(ruleKey: string): Date | null {
    return this.lastEvaluated.get(ruleKey) ?? null
  }

  async evaluate(rule: RuleType, now: Date): Promise<void> {
    if (rule.kind !== 'metric') return

    const row = await this.ruleRows.findByKey(rule.key)
    if (!row || !row.enabled || row.deprecated) return

    let config: MonitorRuleConfig
    try {
      config = MonitorRuleConfigSchema.parse({ ...rule.defaults, ...row.config })
    } catch (error) {
      this.logger.error('monitor.rule.config_invalid', { ruleKey: rule.key, error })
      return
    }

    const metric = this.metrics.get(rule.metricKey)
    if (!metric) {
      this.logger.error('monitor.rule.metric_missing', { ruleKey: rule.key })
      return
    }

    const cutoff = new Date(
      now.getTime() - (metric.scope === 'instance' ? rule.evaluationIntervalSeconds * 1000 : 0),
    )
    const samples = await this.samples.forRule(
      rule.metricKey,
      cutoff,
      rule.lookback,
      rule.evaluationIntervalSeconds,
      config.dimensionType,
      config.dimensionKey,
    )
    if (samples.length === 0) return

    const latest = samples.reduce((current, sample) =>
      sample.windowEnd > current.windowEnd ? sample : current,
    )
    if (this.staleGuard.isStale(metric, latest.windowEnd, now)) {
      this.logger.warn('monitor.rule.stale', { ruleKey: rule.key, lastAt: latest.windowEnd })
      return
    }

    const window: MetricWindow = {
      key: latest.windowKey,
      start: latest.windowStart,
      end: latest.windowEnd,
    }
    const subjects = this.buildSubjects(rule, metric, samples)
    const previousState =
      rule.driver === 'stream' ? await this.streamState.get(rule.key) : new Map()
    const nextState = rule.nextState
      ? rule.nextState(
          { now, window, params: config, subjects, state: previousState },
          previousState,
        )
      : previousState
    const hits = rule
      .match(
        {
          now,
          window,
          params: config,
          subjects,
          state: nextState,
        },
        nextState,
      )
      .map((hit) => ({
        ...hit,
        ruleKey: rule.key,
        windowStart: window.start,
        windowEnd: window.end,
      }))
    if (rule.driver === 'stream') {
      await this.streamState.set(rule.key, nextState, Math.max(rule.windowSeconds * 10, 60))
    }

    const items = await this.lifecycle.reconcileMetric(
      rule,
      row,
      config,
      hits,
      window,
      now,
      this.instance.id,
    )

    for (const item of items) {
      try {
        await this.delivery.deliver(item)
      } catch (error) {
        this.logger.error('monitor.delivery.failed', {
          ruleKey: rule.key,
          subjectId: item.alert.subjectId,
          error,
        })
      }
    }
    this.lastEvaluated.set(rule.key, now)
  }

  private buildSubjects(
    rule: MetricRuleType,
    metric: MetricDefinition,
    samples: MetricSample[],
  ): RuleSubject[] {
    if (rule.instanceMode === 'per-instance' && metric.scope === 'instance') {
      const byInstance = new Map<string, MetricSample[]>()
      for (const sample of samples) {
        const bucket = byInstance.get(sample.instanceId) ?? []
        bucket.push(sample)
        byInstance.set(sample.instanceId, bucket)
      }
      return [...byInstance.entries()].map(([instanceId, rows]) => {
        const ordered = [...rows].sort((a, b) => b.windowEnd.getTime() - a.windowEnd.getTime())
        const recent = ordered.slice(0, rule.lookback)
        return {
          subjectId: `instance:${instanceId}`,
          samples: recent,
          value: aggregate(
            recent.map((row) => row.value),
            rule.aggregation,
          ),
        }
      })
    }

    // aggregate / global：先按维度分组，再按窗口跨实例合成一个序列
    const byDimension = new Map<string, MetricSample[]>()
    for (const sample of samples) {
      const key = `${sample.dimensionType}\u0000${sample.dimensionKey}`
      const bucket = byDimension.get(key) ?? []
      bucket.push(sample)
      byDimension.set(key, bucket)
    }

    return [...byDimension.entries()].map(([, rows]) => {
      const ordered = [...rows].sort((a, b) => b.windowEnd.getTime() - a.windowEnd.getTime())
      const dimensionType = ordered[0]?.dimensionType ?? 'total'
      const dimensionKey = ordered[0]?.dimensionKey ?? ''
      const byWindow = new Map<string, MetricSample[]>()
      for (const row of ordered) {
        const bucket = byWindow.get(row.windowKey) ?? []
        bucket.push(row)
        byWindow.set(row.windowKey, bucket)
      }
      const windowKeys = [...new Set(ordered.map((row) => row.windowKey))].slice(0, rule.lookback)
      const values = windowKeys.map((key) =>
        aggregate(
          (byWindow.get(key) ?? []).map((row) => row.value),
          rule.instanceAggregation,
        ),
      )
      const subjectId =
        metric.scope === 'global'
          ? dimensionType === 'total'
            ? 'total'
            : `${dimensionType}:${dimensionKey}`
          : 'system'
      return {
        subjectId,
        samples: ordered.filter((row) => windowKeys.includes(row.windowKey)),
        value: aggregate(values, rule.aggregation),
      }
    })
  }
}
