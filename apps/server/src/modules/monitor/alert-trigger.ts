import { Inject, Injectable, Optional } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import {
  EmailClient,
  FileClient,
  LarkNotifyClient,
  Notifier,
  Scheduler,
  StreamHub,
  Telemetry,
  type NotifyChannel,
  type NotifyPayload,
  type TelemetrySnapshot,
} from '@repo/kits'
import {
  STREAM_ADMIN_BROADCAST_CHANNEL,
  STREAM_ALERT_FIRED_EVENT,
  type AlertFiredEventModel,
  type SuccessResultModel,
  type TestAlertDto,
} from '@repo/shared'
import { AlertLogRepository } from './alert-log.repository.js'
import { AlertRuleRepository } from './alert-rule.repository.js'
import { MonitorConfig, type MonitorConfig as MonitorConfigType } from './config.js'
import type { AlertRuleEntity } from '../../database/entities/alert-rule-entity.js'

/** 告警触发上下文（可选）：请求路径 / requestId 等辅助定位信息 */
export interface NotifyContext {
  path?: string
  requestId?: string
}

const errorCodeOf = (error: unknown): number | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof (error as { code?: unknown }).code === 'number'
    ? (error as { code: number }).code
    : undefined

const errorMessageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 内容指纹（限频去重用，djb2 哈希）：同规则 + 同通道 + 同内容在窗口内只发一次 */
const simpleHash = (input: string): string => {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

/**
 * 告警触发 bean（独立职责）：
 * - 事件规则（tech / business）：错误码 / 关键字匹配 + **次数阈值窗口**；
 * - 指标规则（metric / surge）：**Scheduler 周期评估** Telemetry 埋点数据（阈值 / 环比基线）；
 * - 超阈值 → 限频 → 经 Notifier 发送 → 落 AlertLog 审计。
 *
 * 规则管理在 `AlertRuleService`；埋点在 `Telemetry`（框架自动埋 + 业务手动埋）；
 * 发送能力归通知模块（FileClient / LarkNotifyClient / EmailClient / Notifier）。
 */
@Injectable()
export class AlertTrigger {
  /** 限频表：`${ruleId}:${channel}:${contentHash}` → 上次发送时间戳（进程内，单实例） */
  private readonly throttleMap = new Map<string, number>()
  /** 事件规则计数窗口：`${ruleId}:${contentHash}` → { count, windowStart }（次数阈值） */
  private readonly eventCounts = new Map<string, { count: number; windowStart: number }>()
  /** metric / surge 规则上次评估时间（periodSeconds 节流） */
  private readonly lastEvaluatedAt = new Map<string, number>()


  constructor(
    @Inject(MonitorConfig) private readonly config: MonitorConfigType,
    @Inject(AlertRuleRepository)
    private readonly ruleRepository: AlertRuleRepository,
    @Inject(AlertLogRepository)
    private readonly logRepository: AlertLogRepository,
    @Inject(Notifier) private readonly notifier: Notifier,
    @Inject(Telemetry) private readonly telemetry: Telemetry,
    @Inject(Scheduler) private readonly scheduler: Scheduler,
    @Inject(AppLogger) private readonly logger: AppLogger,
    // 告警实时推送：发送成功后向管理员广播频道推 `alert.fired`（实时告警页订阅）
    @Inject(StreamHub) private readonly streamHub: StreamHub,
    // 通知客户端按配置装配（未配置的通道不注册），用于默认技术规则的通道判定
    @Inject(FileClient)
    @Optional()
    private readonly fileClient?: FileClient,
    @Inject(LarkNotifyClient)
    @Optional()
    private readonly larkNotify?: LarkNotifyClient,
    @Inject(EmailClient)
    @Optional()
    private readonly email?: EmailClient,
  ) {
    // 周期评估 metric / surge 规则（构造期注册，Scheduler 启动后生效）
    this.scheduler.scheduleInterval('monitor-metric-eval', 10_000, () => {
      void this.evaluateMetricRules()
    })
  }

  /**
   * 告警入口（技术 / 业务错误统一调用，如 errorHandler 与进程级异常）：
   * 规则表为空 → 默认技术规则兜底（配置启用的通道 + 文件输出，开箱即用）；
   * 规则表有规则 → 仅按事件规则匹配（错误码 / 关键字 + 次数阈值），不匹配不告警。
   */
  async notifyError(error: unknown, context?: NotifyContext): Promise<void> {
    if (!this.config.enabled) return
    const code = errorCodeOf(error)
    const message = errorMessageOf(error)
    const title = code !== undefined ? `告警：错误码 ${code}` : '告警：未捕获异常'

    const rules = await this.ruleRepository.findAllEnabled()

    if (rules.length === 0) {
      // 无任何启用规则：默认技术规则兜底（配置通道 + 文件输出）
      const channels = this.defaultChannels()
      if (channels.length === 0) return
      await this.deliver(null, '默认技术告警', title, message, channels, context, 60)
      return
    }

    const matched = rules.filter((rule) => this.matchRule(rule, code, message))
    for (const rule of matched) {
      await this.deliverEventRule(rule, title, message, context)
    }
  }

  /** 测试告警（admin 手动验证通道可用性） */
  async testNotify(input: TestAlertDto): Promise<SuccessResultModel> {
    await this.deliver(
      null,
      '测试告警',
      input.title,
      input.message,
      input.channels,
      undefined,
      0,
    )
    return { success: true }
  }

  /** 规则匹配：enabled + 错误码（matchCodes 空=全部）+ 关键字（keywords 空=不限） */
  private matchRule(rule: AlertRuleEntity, code: number | undefined, message: string): boolean {
    if (!rule.enabled) return false
    if (rule.matchCodes.length > 0) {
      if (code === undefined || !rule.matchCodes.includes(code)) return false
    }
    if (rule.keywords.length > 0) {
      if (!rule.keywords.some((keyword) => message.includes(keyword))) return false
    }
    return true
  }

  /** 默认技术规则通道：文件输出始终可用 + 已配置（configured）的客户端 */
  private defaultChannels(): NotifyChannel[] {
    const channels: NotifyChannel[] = []
    if (this.fileClient?.configured) channels.push('file')
    if (this.larkNotify?.configured) channels.push('lark')
    if (this.email?.configured) channels.push('email')
    return channels
  }

  /**
   * 事件规则触发（含次数阈值）：窗口内同错误出现 ≥ threshold 才告警；
   * 触发后重置窗口计数（避免窗口内每个请求重复触发，配合限频防风暴）。
   */
  private async deliverEventRule(
    rule: AlertRuleEntity,
    title: string,
    message: string,
    context: NotifyContext | undefined,
  ): Promise<void> {
    const countKey = `${rule.id}:${simpleHash(`${title}\n${message}`)}`
    const now = Date.now()
    const entry = this.eventCounts.get(countKey)
    if (!entry || now - entry.windowStart >= rule.thresholdWindowSeconds * 1000) {
      this.eventCounts.set(countKey, { count: 1, windowStart: now })
    } else {
      entry.count += 1
    }
    const current = this.eventCounts.get(countKey)!
    if (current.count < rule.threshold) return
    // 达到阈值：触发后清计数（窗口内只触发一次）
    this.eventCounts.delete(countKey)
    await this.deliver(
      rule.id,
      rule.name,
      title,
      message,
      rule.channels as NotifyChannel[],
      context,
      rule.throttleSeconds,
    )
  }

  /** 周期评估 metric / surge 规则（Scheduler 驱动，periodSeconds 节流） */
  private async evaluateMetricRules(): Promise<void> {
    if (!this.config.enabled) return
    const rules = (await this.ruleRepository.findAllEnabled()).filter(
      (rule) => rule.type === 'metric' || rule.type === 'surge',
    )
    if (rules.length === 0) return

    const snapshot = this.telemetry.snapshot()
    const values = this.buildMetricValues(snapshot)
    const now = Date.now()

    for (const rule of rules) {
      const lastAt = this.lastEvaluatedAt.get(rule.id) ?? 0
      if (now - lastAt < rule.periodSeconds * 1000) continue
      this.lastEvaluatedAt.set(rule.id, now)

      const value =
        rule.type === 'surge'
          ? this.surgeRatio(rule, values)
          : (values.current[rule.metric ?? ''] ?? null)
      if (value === null || value === undefined || !Number.isFinite(value)) continue

      if (this.compare(value, rule.operator, rule.thresholdValue)) {
        const detail = `${rule.metric} = ${value.toFixed(2)} ${rule.operator ?? ''} ${rule.thresholdValue ?? ''}`
        await this.deliver(
          rule.id,
          rule.name,
          `告警：${rule.name}`,
          detail,
          rule.channels as NotifyChannel[],
          undefined,
          rule.throttleSeconds,
        )
      }
    }
  }

  /** 突变规则环比：当前窗口 / 前一窗口（rate 比值）；无基线或基线 ≤ 0 返回 null（跳过） */
  private surgeRatio(
    rule: AlertRuleEntity,
    values: { current: Record<string, number>; previous: Record<string, number> },
  ): number | null {
    const metric = rule.metric ?? ''
    const current = values.current[metric]
    const previous = values.previous[metric]
    if (current === undefined || previous === undefined || previous <= 0) return null
    return current / previous
  }

  /** 构建指标值：内置语义指标（错误率 / QPS / 平均耗时 / P95 / P99 / 内存）+ 原始 counter(rate) / gauge */
  private buildMetricValues(
    snapshot: TelemetrySnapshot,
  ): { current: Record<string, number>; previous: Record<string, number> } {
    const current: Record<string, number> = {}
    const previous: Record<string, number> = {}

    const total = snapshot.counters['request.count'] ?? 0
    const errors = snapshot.counters['request.error'] ?? 0
    current['request.errorRate'] = total > 0 ? errors / total : 0
    current['request.qps'] = total / snapshot.windowSeconds
    const histogram = snapshot.histograms['request.duration']
    if (histogram) {
      current['request.avgDuration'] = histogram.count > 0 ? histogram.sum / histogram.count : 0
      current['request.p95'] = histogram.quantile(0.95)
      current['request.p99'] = histogram.quantile(0.99)
    }
    const memory = process.memoryUsage()
    current['process.memory'] = memory.heapTotal > 0 ? memory.heapUsed / memory.heapTotal : 0

    // 原始指标：counter → rate（每秒），gauge → 当前值
    for (const [name, value] of Object.entries(snapshot.counters)) {
      current[name] = value / snapshot.windowSeconds
    }
    for (const [name, value] of Object.entries(snapshot.gauges)) {
      current[name] = value
    }
    // 前一窗口（surge 基线，rate）
    const previousTotal = snapshot.previousCounters['request.count'] ?? 0
    previous['request.qps'] = previousTotal / snapshot.windowSeconds
    for (const [name, value] of Object.entries(snapshot.previousCounters)) {
      previous[name] = value / snapshot.windowSeconds
    }
    return { current, previous }
  }

  /** 比较符判定 */
  private compare(value: number, operator: string | null, threshold: number | null): boolean {
    if (threshold === null || operator === null) return false
    switch (operator) {
      case 'gt':
        return value > threshold
      case 'gte':
        return value >= threshold
      case 'lt':
        return value < threshold
      case 'lte':
        return value <= threshold
      default:
        return false
    }
  }

  /** 限频判定：窗口内同内容不重复发；惰性清理过期条目 */
  private isThrottled(key: string, throttleSeconds: number): boolean {
    const lastSentAt = this.throttleMap.get(key)
    if (lastSentAt === undefined) return false
    if (Date.now() - lastSentAt < throttleSeconds * 1000) return true
    this.throttleMap.delete(key)
    return false
  }

  private composeMessage(title: string, message: string, context?: NotifyContext): string {
    const lines = [`【${title}】`, message]
    if (context?.path) lines.push(`请求路径：${context.path}`)
    if (context?.requestId) lines.push(`RequestId：${context.requestId}`)
    return lines.join('\n')
  }

  /** 按通道发送（经 Notifier）并逐通道落 AlertLog；发送 / 落库失败均不抛错 */
  private async deliver(
    ruleId: string | null,
    ruleName: string,
    title: string,
    message: string,
    channels: NotifyChannel[],
    context: NotifyContext | undefined,
    throttleSeconds: number,
  ): Promise<void> {
    const content = this.composeMessage(title, message, context)
    // 限频 key 基于「规则 + 通道 + 标题 + 错误消息」（不含 requestId / path 等每次请求变化的上下文）
    const throttleKeyBase = `${ruleId ?? 'default'}:${simpleHash(`${title}\n${message}`)}`
    for (const channel of channels) {
      const throttleKey = `${throttleKeyBase}:${channel}`
      if (throttleSeconds > 0 && this.isThrottled(throttleKey, throttleSeconds)) {
        continue
      }
      const payload: NotifyPayload =
        channel === 'lark' || channel === 'file'
          ? { content }
          : { to: this.config.emailTo ?? '', subject: title, text: content }

      const result = await this.notifier.send(channel, payload)
      const sentAt = new Date()
      await this.logRepository
        .save({
          ruleId,
          ruleName,
          title,
          message: content,
          channel,
          status: result.ok ? 'success' : 'failed',
          error: result.error ?? null,
          sentAt,
        })
        .catch((cause) => this.logger.error('告警记录落库失败', { error: cause }))

      // 实时推送（管理员端「实时告警」页）：与落库用同一个 sentAt，两边时间一致
      this.publishAlertFired({
        ruleId,
        ruleName,
        title,
        message: content,
        channel,
        status: result.ok ? 'success' : 'failed',
        error: result.error ?? null,
        sentAt: sentAt.toISOString(),
      })

      // 限频记录「尝试即记」：发送失败也记，避免失败通道重复告警风暴
      if (throttleSeconds > 0) {
        this.throttleMap.set(throttleKey, Date.now())
      }
    }
  }

  /**
   * 推送告警事件到管理员广播频道（SSE `alert.fired`）。
   *
   * 实时推送是**旁路**：只读展示用，不参与告警主流程，推失败也不影响「已发送 + 已落库」的事实，
   * 故这里吞掉异常只记日志（与落库失败同一姿态）。
   */
  private publishAlertFired(payload: AlertFiredEventModel): void {
    try {
      this.streamHub.publish(STREAM_ADMIN_BROADCAST_CHANNEL, {
        event: STREAM_ALERT_FIRED_EVENT,
        data: payload,
      })
    } catch (error) {
      this.logger.warn('告警实时推送失败', { error })
    }
  }
}
