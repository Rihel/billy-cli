import { Inject, Injectable, Optional } from '@repo/di'
import { EmailClient } from './email/email.client.js'
import { FileClient } from './file/file.client.js'
import { LarkNotifyClient } from './lark-notify/lark-notify.client.js'

/** 可用通知通道（第一版；钉钉 / 企业微信预留） */
export type NotifyChannel = 'file' | 'lark' | 'email'

/** 各通道入参（调用方按通道组装） */
export type NotifyPayload =
  | { content: string } // lark 文本
  | { to: string; subject: string; text: string } // email（to 由调用方决定）

/** 发送结果：失败不抛错（各客户端内部记日志），由调用方决定落库 / 重试 */
export interface SendResult {
  ok: boolean
  error?: string
}

/** 统一通知客户端接口（每个通知通道一个平级目录模块实现） */
export interface NotifyClient {
  readonly channel: NotifyChannel
  /** 是否已配置（未配置的通道 send 返回 { ok:false, error: '通道未配置' }） */
  readonly configured: boolean
  send(payload: NotifyPayload): Promise<SendResult>
}

/**
 * 通知编排门面：通过 DI 注入各通知客户端，`send(channel, payload)` 按通道路由。
 * 自身零发送实现；业务也可绕过本门面直接注入客户端（如只发飞书）。
 *
 * 客户端为「按配置存在装配」的组件（未配置的通道不注册），这里用 @Optional 注入，
 * 未装配的通道 send 返回 `{ ok:false, error: '通道未配置' }`。
 * 新增通知通道（钉钉 / 企业微信等）：新增一个平级目录模块（实现 NotifyClient），
 * 在构造器注入并加一个路由分支即可，调用方接口不变。
 * 注意：`LarkNotifyClient` 基于 `LarkClient`（官方 SDK 封装）实现，协议能力在 LarkClient。
 */
@Injectable()
export class Notifier {
  constructor(
    @Inject(FileClient)
    @Optional()
    private readonly file?: FileClient,
    @Inject(LarkNotifyClient)
    @Optional()
    private readonly lark?: LarkNotifyClient,
    @Inject(EmailClient)
    @Optional()
    private readonly email?: EmailClient,
    // 预留：钉钉 / 企业微信通知客户端后续在构造器注入
  ) {}

  async send(channel: NotifyChannel, payload: NotifyPayload): Promise<SendResult> {
    switch (channel) {
      case 'file':
        return this.file
          ? this.file.send(payload)
          : { ok: false, error: '通道未配置：file' }
      case 'lark':
        return this.lark
          ? this.lark.send(payload)
          : { ok: false, error: '通道未配置：lark' }
      case 'email':
        return this.email
          ? this.email.send(payload)
          : { ok: false, error: '通道未配置：email' }
    }
  }
}
