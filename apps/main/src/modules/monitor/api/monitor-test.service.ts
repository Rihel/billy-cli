import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, Notifier, type NotifyChannel, type NotifyPayload } from '@repo/kits'
import type { SuccessResultModel, TestAlertDto } from '@repo/shared'
import { MonitorConfig, type MonitorConfig as MonitorConfigType } from '../config.js'
import { AlertLogRepository } from '../engine/alert-log.repository.js'

/** 测试通知：只验证通道是否可用，不进入告警生命周期 */
@Injectable()
export class MonitorTestService {
  constructor(
    @Inject(Notifier) private readonly notifier: Notifier,
    @Inject(AlertLogRepository) private readonly logs: AlertLogRepository,
    @Inject(MonitorConfig) private readonly config: MonitorConfigType,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async send(input: TestAlertDto): Promise<SuccessResultModel> {
    for (const channel of input.channels as NotifyChannel[]) {
      const payload: NotifyPayload =
        channel === 'lark' || channel === 'file'
          ? { content: `${input.title}\n${input.message}` }
          : { to: this.config.emailTo ?? '', subject: input.title, text: input.message }
      const result = await this.notifier.send(channel, payload)
      await this.logs
        .save({
          alertId: null,
          ruleId: null,
          ruleName: '测试告警',
          title: input.title,
          message: input.message,
          channel,
          status: result.ok ? 'success' : 'failed',
          error: result.error ?? null,
          sentAt: new Date(),
        })
        .catch((error) => this.logger.error('测试告警记录落库失败', { error }))
    }
    return { success: true }
  }
}
