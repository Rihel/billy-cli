import { Inject, Injectable } from '@nestjs/common'
import {
  AppLogger,
  Notifier,
  type NotifyChannel,
  type NotifyPayload,
} from '@repo/kits'
import type { MonitorRuleConfig } from '@repo/shared'
import type { MonitorAlertEntity } from '../../../database/entities/monitor-alert-entity.js'
import type { MonitorRuleEntity } from '../../../database/entities/monitor-rule-entity.js'
import type { MetricWindow } from '../definitions/metric.types.js'
import type { Hit, MonitorErrorEvent, RuleType } from '../definitions/rule.types.js'
import { MonitorConfig, type MonitorConfig as MonitorConfigType } from '../config.js'
import { AlertLogRepository } from './alert-log.repository.js'
import { AlertStreamService } from './alert-stream.service.js'
import { SilenceService } from './silence.service.js'

export interface DeliveryInput {
  alert: MonitorAlertEntity
  rule: RuleType
  row: MonitorRuleEntity
  config: MonitorRuleConfig
  hit: Hit
  window: MetricWindow
  event?: MonitorErrorEvent
}

export interface RecoveryDeliveryInput {
  alert: MonitorAlertEntity
  rule: RuleType
  row: MonitorRuleEntity
  config: MonitorRuleConfig
}

/** 告警投递：一次投递的编排（静默 → 通知 → 发送记录 → SSE） */
@Injectable()
export class AlertDeliveryService {
  constructor(
    @Inject(Notifier) private readonly notifier: Notifier,
    @Inject(AlertLogRepository) private readonly logs: AlertLogRepository,
    @Inject(SilenceService) private readonly silence: SilenceService,
    @Inject(AlertStreamService) private readonly stream: AlertStreamService,
    @Inject(MonitorConfig) private readonly config: MonitorConfigType,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 返回是否至少有一个通道发送成功；全失败不写静默，下一轮重试 */
  async deliver(input: DeliveryInput): Promise<boolean> {
    const { alert, rule, row, config, hit, window, event } = input
    if (await this.silence.isSilenced(rule.key, alert.subjectId)) return false

    const title = `[${levelLabel(config.level)}] ${rule.name}`
    const message = this.composeMessage(rule, config, hit, window, event)
    let anySuccess = false

    for (const channel of config.channels as NotifyChannel[]) {
      const payload = this.payloadOf(channel, title, message)
      const result = await this.notifier.send(channel, payload)
      const sentAt = new Date()

      await this.logs
        .save({
          alertId: alert.id,
          ruleId: row.id,
          ruleName: rule.name,
          title,
          message,
          channel,
          status: result.ok ? 'success' : 'failed',
          error: result.error ?? null,
          sentAt,
        })
        .catch((error) => this.logger.error('告警发送记录落库失败', { error }))

      this.stream.publish({
        ruleId: row.id,
        ruleName: rule.name,
        title,
        message,
        channel,
        status: result.ok ? 'success' : 'failed',
        error: result.error ?? null,
        sentAt: sentAt.toISOString(),
      })

      if (result.ok) anySuccess = true
    }

    if (anySuccess) {
      await this.silence.mark(rule.key, alert.subjectId, config.silenceSeconds)
    }
    return anySuccess
  }

  /** 恢复通知：不受静默键影响，只发一次 */
  async deliverRecovery(input: RecoveryDeliveryInput): Promise<boolean> {
    const { alert, rule, row, config } = input
    const title = `[恢复] ${rule.name}`
    const recoveredAt = alert.recoveredAt ?? new Date()
    const durationMs = Math.max(0, recoveredAt.getTime() - alert.firstFiredAt.getTime())
    const message = [
      `规则：${rule.name}（${rule.key}）`,
      `状态：已恢复`,
      `主体：${alert.subjectId}`,
      `首次告警：${alert.firstFiredAt.toISOString()}`,
      `恢复时间：${recoveredAt.toISOString()}`,
      `持续时长：${Math.round(durationMs / 1000)} 秒`,
    ].join('\n')

    let anySuccess = false
    for (const channel of config.channels as NotifyChannel[]) {
      const payload = this.payloadOf(channel, title, message)
      const result = await this.notifier.send(channel, payload)
      const sentAt = new Date()
      await this.logs
        .save({
          alertId: alert.id,
          ruleId: row.id,
          ruleName: rule.name,
          title,
          message,
          channel,
          status: result.ok ? 'success' : 'failed',
          error: result.error ?? null,
          sentAt,
        })
        .catch((error) => this.logger.error('恢复通知记录落库失败', { error }))
      this.stream.publish({
        ruleId: row.id,
        ruleName: rule.name,
        title,
        message,
        channel,
        status: result.ok ? 'success' : 'failed',
        error: result.error ?? null,
        sentAt: sentAt.toISOString(),
      })
      if (result.ok) anySuccess = true
    }
    return anySuccess
  }

  private payloadOf(channel: NotifyChannel, title: string, message: string): NotifyPayload {
    if (channel === 'lark' || channel === 'file') {
      return { content: `${title}\n${message}` }
    }
    return { to: this.config.emailTo ?? '', subject: title, text: message }
  }

  private composeMessage(
    rule: RuleType,
    config: MonitorRuleConfig,
    hit: Hit,
    window: MetricWindow,
    event?: MonitorErrorEvent,
  ): string {
    const lines = [
      `规则：${rule.name}（${rule.key}）`,
      `级别：${levelLabel(config.level)}`,
      `主体：${hit.subjectId}`,
      `窗口：${window.start.toISOString()} ~ ${window.end.toISOString()}`,
    ]
    if (config.operator && config.threshold !== undefined) {
      lines.push(`当前值：${hit.value}（阈值 ${operatorLabel(config.operator)} ${config.threshold}）`)
    } else {
      lines.push(`当前值：${hit.value}`)
    }
    if (event) {
      if (event.code !== undefined) lines.push(`错误码：${event.code}`)
      lines.push(`消息：${event.message}`)
      if (event.path) lines.push(`请求路径：${event.path}`)
      if (event.requestId) lines.push(`RequestId：${event.requestId}`)
    }
    return lines.join('\n')
  }
}

const levelLabel = (level: MonitorRuleConfig['level']): string => {
  switch (level) {
    case 'critical':
      return '严重'
    case 'error':
      return '错误'
    default:
      return '警告'
  }
}

const operatorLabel = (operator: MonitorRuleConfig['operator']): string => {
  switch (operator) {
    case 'gt':
      return '>'
    case 'gte':
      return '≥'
    case 'lt':
      return '<'
    case 'lte':
      return '≤'
    default:
      return operator
  }
}
