import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '../../foundation/logger/app-logger.js'
import nodemailer, { type Transporter } from 'nodemailer'
import { NotifyConfig } from '../notify.config.js'
import type { NotifyClient, NotifyPayload, SendResult } from '../notifier.js'

/**
 * 邮件客户端（nodemailer SMTP）。
 *
 * 独立模块：协议封装（SMTP 传输）+ 配置读取（NotifyConfig.email）；
 * 与其它基础设施模块平级；可独立注入使用，也可经 Notifier 编排。
 * `to` 由调用方传入（告警接收人 / 用户邮箱），`from` 在配置。
 */
@Injectable()
export class EmailClient implements NotifyClient {
  readonly channel = 'email' as const

  private readonly transport: Transporter | null = null
  private readonly from: string | undefined


  constructor(@Inject(NotifyConfig) config: NotifyConfig,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    const email = config.email
    if (email) {
      this.from = email.from
      this.transport = nodemailer.createTransport({
        host: email.host,
        port: email.port,
        secure: email.secure,
        ...(email.user && email.pass
          ? { auth: { user: email.user, pass: email.pass } }
          : {}),
      })
    }
  }

  get configured(): boolean {
    return this.transport !== null
  }

  async send(payload: NotifyPayload): Promise<SendResult> {
    if (!this.transport || !this.from) {
      return { ok: false, error: '通道未配置：email' }
    }
    if (!('to' in payload)) {
      return { ok: false, error: '邮件客户端仅支持 to / subject / text 消息' }
    }
    try {
      await this.transport.sendMail({
        from: this.from,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
      })
      return { ok: true }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.logger.error('邮件发送失败', { to: payload.to, error: message })
      return { ok: false, error: message }
    }
  }
}
