import { Inject, Injectable } from '@nestjs/common'
import type { MonitorEngineStatusModel } from '@repo/shared'
import { AlertRepository } from '../engine/alert.repository.js'
import { MetricRegistry } from '../engine/metric.registry.js'
import { MetricSampleRepository } from '../engine/metric-sample.repository.js'
import { MonitorEngine } from '../engine/monitor.engine.js'
import { MonitorInstanceService } from '../engine/instance.service.js'
import { MonitorRuleRepository } from '../engine/monitor-rule.repository.js'
import { RuleEvaluatorService } from '../engine/rule-evaluator.service.js'
import { RuleRegistry } from '../engine/rule.registry.js'
import { StaleGuard } from '../engine/stale.guard.js'

/** 引擎状态读模型 */
@Injectable()
export class MonitorEngineService {
  constructor(
    @Inject(MonitorEngine) private readonly engine: MonitorEngine,
    @Inject(MonitorInstanceService) private readonly instance: MonitorInstanceService,
    @Inject(MetricRegistry) private readonly metrics: MetricRegistry,
    @Inject(RuleRegistry) private readonly rules: RuleRegistry,
    @Inject(MonitorRuleRepository) private readonly ruleRows: MonitorRuleRepository,
    @Inject(MetricSampleRepository) private readonly samples: MetricSampleRepository,
    @Inject(AlertRepository) private readonly alerts: AlertRepository,
    @Inject(RuleEvaluatorService) private readonly evaluator: RuleEvaluatorService,
    @Inject(StaleGuard) private readonly staleGuard: StaleGuard,
  ) {}

  async status(): Promise<MonitorEngineStatusModel> {
    const now = new Date()
    const slotRuns = new Map(this.engine.slotStatus().map((slot) => [slot.intervalSeconds, slot]))
    const slots = this.rules.intervals().map((interval) => {
      const run = slotRuns.get(interval)
      return {
        intervalSeconds: interval,
        lastRunAt: run?.lastRunAt ?? null,
        lastDurationMs: run?.lastDurationMs ?? null,
        running: run?.running ?? false,
      }
    })

    const metrics = await Promise.all(
      this.metrics.all().map(async (metric) => {
        const last = await this.samples.lastWindowEnd(metric.key)
        return {
          metricKey: metric.key,
          lastSampleAt: last,
          stale: this.staleGuard.isStale(metric, last, now),
        }
      }),
    )

    const rows = await this.ruleRows.findAll()
    const ruleStatuses = await Promise.all(
      rows.map(async (row) => ({
        ruleKey: row.ruleKey,
        lastEvaluatedAt: this.evaluator.lastEvaluatedAt(row.ruleKey),
        lastFiredAt: await this.alerts.lastFiredAt(row.ruleKey),
      })),
    )

    return {
      instanceId: this.instance.id,
      leader: this.engine.isLeader(),
      slots,
      metrics,
      rules: ruleStatuses,
    }
  }
}
