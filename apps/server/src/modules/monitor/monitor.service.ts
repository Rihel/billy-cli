import { Inject, Injectable, Optional } from '@repo/di'
import type { AppLogger } from '@repo/shared/logger'
import { Logger } from '@repo/kits'
import {
  EmailClient,
  LarkNotifyClient,
  Notifier,
  type NotifyChannel,
  type NotifyPayload,
} from '@repo/kits'
import type { SuccessResultModel, TestAlertDto } from '@repo/shared'
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
 * 告警核心服务：规则匹配 → 限频防风暴 → 经 Notifier 发送 → 落 AlertLog 审计。
 *
 * 发送能力归通知模块（LarkClient / LarkNotifyClient / EmailClient / Notifier），
 * 本服务只做「规则 / 匹配 / 触发 / 记录」。
 */
@Injectable()
export class MonitorService {
  /** 限频表：`${ruleId}:${channel}:${contentHash}` → 上次发送时间戳（进程内，单实例） */
  private readonly throttleMap = new Map<string, number>()

  @Logger()
  private readonly logger!: AppLogger

  constructor(
    @Inject(MonitorConfig) private readonly config: MonitorConfigType,
    @Inject(AlertRuleRepository)
    private readonly ruleRepository: AlertRuleRepository,
    @Inject(AlertLogRepository)
    private readonly logRepository: AlertLogRepository,
    @Inject(Notifier) private readonly notifier: Notifier,
    // 通知客户端按配置装配（未配置的通道不注册），用于默认技术规则的通道判定
    @Inject(LarkNotifyClient)
    @Optional()
    private readonly larkNotify?: LarkNotifyClient,
    @Inject(EmailClient)
    @Optional()
    private readonly email?: EmailClient,
  ) {}

  /**
   * 告警入口（技术 / 业务错误统一调用，如 errorHandler 与进程级异常）：
   * 规则表为空 → 默认技术规则兜底（配置启用的通道，开箱即用）；
   * 规则表有规则 → 仅按规则匹配（错误码 / 关键字），不匹配不告警（避免默认规则重复兜底噪音）。
   */
  async notifyError(error: unknown, context?: NotifyContext): Promise<void> {
    if (!this.config.enabled) return
    const code = errorCodeOf(error)
    const message = errorMessageOf(error)
    const title = code !== undefined ? `告警：错误码 ${code}` : '告警：未捕获异常'

    const rules = await this.ruleRepository.findAllEnabled()

    if (rules.length === 0) {
      // 无任何启用规则：默认技术规则兜底（NotifyConfig / LarkConfig 已配置的通道）
      const channels = this.defaultChannels()
      if (channels.length === 0) return
      await this.deliver(null, '默认技术告警', title, message, channels, context, 60)
      return
    }

    const matched = rules.filter((rule) => this.matchRule(rule, code, message))
    for (const rule of matched) {
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

  /** 默认技术规则通道：通知模块中已配置（configured）的客户端 */
  private defaultChannels(): NotifyChannel[] {
    const channels: NotifyChannel[] = []
    if (this.larkNotify?.configured) channels.push('lark')
    if (this.email?.configured) channels.push('email')
    return channels
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
        channel === 'lark'
          ? { content }
          : { to: this.config.emailTo ?? '', subject: title, text: content }

      const result = await this.notifier.send(channel, payload)
      await this.logRepository
        .save({
          ruleId,
          ruleName,
          title,
          message: content,
          channel,
          status: result.ok ? 'success' : 'failed',
          error: result.error ?? null,
          sentAt: new Date(),
        })
        .catch((cause) => this.logger.error('告警记录落库失败', { error: cause }))

      // 限频记录「尝试即记」：发送失败也记，避免失败通道重复告警风暴
      if (throttleSeconds > 0) {
        this.throttleMap.set(throttleKey, Date.now())
      }
    }
  }
}
