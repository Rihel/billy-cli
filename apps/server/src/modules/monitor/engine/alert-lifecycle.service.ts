import { Inject, Injectable } from '@nestjs/common'
import type { MonitorAlertSnapshot, MonitorRuleConfig } from '@repo/shared'
import type { MonitorRuleEntity } from '../../../database/entities/monitor-rule-entity.js'
import type { MonitorAlertEntity } from '../../../database/entities/monitor-alert-entity.js'
import type { MetricWindow } from '../definitions/metric.types.js'
import type {
  EventRuleType,
  Hit,
  MetricRuleType,
  MonitorErrorEvent,
  RuleType,
} from '../definitions/rule.types.js'
import { AlertRepository } from './alert.repository.js'
import { AlertDeliveryService } from './alert-delivery.service.js'

export interface AlertDeliveryItem {
  alert: MonitorAlertEntity
  hit: Hit
  rule: MetricRuleType
  row: MonitorRuleEntity
  config: MonitorRuleConfig
  window: MetricWindow
}

/** 告警记录生命周期：首次 / 最近命中 / 恢复 / 时长 / 首末快照 */
@Injectable()
export class AlertLifecycleService {
  constructor(
    @Inject(AlertRepository) private readonly alerts: AlertRepository,
    @Inject(AlertDeliveryService) private readonly delivery: AlertDeliveryService,
  ) {}

  /**
   * 指标规则每轮评估后调用：
   * - 命中的主体 upsert firing（首次写 first，后续只更新 last）；
   * - 未命中的开放告警累加 miss_count，达到 recoverAfterWindows 后恢复。
   */
  async reconcileMetric(
    rule: MetricRuleType,
    row: MonitorRuleEntity,
    config: MonitorRuleConfig,
    hits: readonly Hit[],
    window: MetricWindow,
    now: Date,
    evaluatingInstanceId: string,
  ): Promise<AlertDeliveryItem[]> {
    const open = await this.alerts.findOpenByRule(rule.key)
    const hitSubjects = new Set(hits.map((hit) => hit.subjectId))
    const items: AlertDeliveryItem[] = []

    for (const hit of hits) {
      const instanceId = hit.subjectId.startsWith('instance:')
        ? hit.subjectId.slice('instance:'.length)
        : evaluatingInstanceId
      const snapshot = this.metricSnapshot(hit, config, window)
      const alert = await this.alerts.upsertFiring({
        ruleKey: rule.key,
        ruleName: rule.name,
        kind: 'metric',
        level: config.level,
        subjectId: hit.subjectId,
        instanceId,
        value: hit.value,
        threshold: config.threshold,
        windowKey: window.key,
        snapshot: snapshot as unknown as Record<string, unknown>,
        now,
      })
      items.push({ alert, hit, rule, row, config, window })
    }

    for (const alert of open) {
      if (hitSubjects.has(alert.subjectId)) continue
      const misses = await this.alerts.markMiss(alert.id)
      if (misses >= config.recoverAfterWindows) {
        await this.resolveWithNotify(alert, rule, row, config, window, now)
      }
    }

    return items
  }

  /** 事件规则命中：创建 / 更新告警记录 */
  async createEventAlert(
    rule: EventRuleType,
    row: MonitorRuleEntity,
    config: MonitorRuleConfig,
    event: MonitorErrorEvent,
    count: number,
    windowKey: string,
    now: Date,
    instanceId: string,
  ): Promise<MonitorAlertEntity> {
    const subjectId = event.code !== undefined ? `code:${event.code}` : 'uncaught'
    const snapshot = this.eventSnapshot(event)
    return this.alerts.upsertFiring({
      ruleKey: rule.key,
      ruleName: rule.name,
      kind: 'event',
      level: config.level,
      subjectId,
      instanceId,
      value: count,
      threshold: config.threshold,
      windowKey,
      snapshot: snapshot as unknown as Record<string, unknown>,
      now,
    })
  }

  /** 事件规则恢复：一段时间没有新事件就 resolved */
  async resolveLapsed(
    rule: EventRuleType,
    row: MonitorRuleEntity,
    config: MonitorRuleConfig,
    now: Date,
  ): Promise<void> {
    const open = await this.alerts.findOpenByRule(rule.key)
    const thresholdMs = rule.windowSeconds * config.recoverAfterWindows * 1000
    for (const alert of open) {
      if (now.getTime() - alert.lastFiredAt.getTime() >= thresholdMs) {
        await this.resolveWithNotify(alert, rule, row, config, {
          key: alert.windowKey ?? '',
          start: alert.firstFiredAt,
          end: now,
        }, now)
      }
    }
  }

  /** 规则禁用 / 删除时批量恢复，避免留下永远不恢复的记录（不发恢复通知） */
  async resolveByRule(ruleKey: string, now: Date): Promise<number> {
    return this.alerts.resolveByRule(ruleKey, now)
  }

  private async resolveWithNotify(
    alert: MonitorAlertEntity,
    rule: RuleType,
    row: MonitorRuleEntity,
    config: MonitorRuleConfig,
    window: MetricWindow,
    now: Date,
  ): Promise<void> {
    await this.alerts.resolve(alert, now)
    if (!config.notifyOnRecovery) return
    try {
      await this.delivery.deliverRecovery({
        alert: { ...alert, recoveredAt: now } as MonitorAlertEntity,
        rule,
        row,
        config,
      })
    } catch {
      // 恢复通知失败不影响恢复事实
    }
  }

  private metricSnapshot(
    hit: Hit,
    config: MonitorRuleConfig,
    window: MetricWindow,
  ): MonitorAlertSnapshot {
    return {
      kind: 'metric',
      value: hit.value,
      threshold: config.threshold,
      operator: config.operator,
      window: {
        key: window.key,
        start: window.start.toISOString(),
        end: window.end.toISOString(),
      },
      samples: (hit.samples ?? []).slice(0, 20).map((sample) => ({
        windowKey: sample.windowKey,
        value: sample.value,
        instanceId: sample.instanceId,
        dimensionType: sample.dimensionType,
        dimensionKey: sample.dimensionKey,
      })),
      labels: hit.labels,
    }
  }

  private eventSnapshot(event: MonitorErrorEvent): MonitorAlertSnapshot {
    return {
      kind: 'event',
      code: event.code,
      message: truncate(event.message, 2000),
      stack: event.stack ? truncate(event.stack, 4000) : undefined,
      path: event.path,
      requestId: event.requestId,
      at: event.at.toISOString(),
    }
  }
}

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`
