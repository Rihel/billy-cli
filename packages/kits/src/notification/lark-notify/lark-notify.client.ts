import { Inject, Injectable, Optional } from '@nestjs/common'
import { AppLogger } from '../../foundation/logger/app-logger.js'
import { NotifyConfig } from '../notify.config.js'
import type { NotifyClient, NotifyPayload, SendResult } from '../notifier.js'
import { LarkClient } from '../../lark/lark.client.js'

/** 飞书接收人 id 类型（对齐官方 SDK receive_id_type） */
type LarkReceiveIdType = 'open_id' | 'chat_id' | 'union_id' | 'user_id' | 'email'

/**
 * 飞书通知客户端：基于 LarkClient（官方 SDK）实现「通知」语义。
 *
 * 独立 bean：注入 `LarkClient` 发文本消息到配置的接收人（用户 open_id / 群 chat_id 等）；
 * 与其它基础设施模块平级；可独立注入使用，也可经 Notifier 编排。
 * 协议细节（App 凭证 / API 调用）归 LarkClient，本类只关心「通知目标与消息形状」。
 */
@Injectable()
export class LarkNotifyClient implements NotifyClient {
  readonly channel = 'lark' as const

  private readonly receiveId: string | undefined
  private readonly receiveIdType: LarkReceiveIdType


  constructor(
    @Inject(NotifyConfig) config: NotifyConfig,
    @Inject(AppLogger) private readonly logger: AppLogger,
    // 未导入 LarkModule 时 LarkClient 缺失：可选注入，通道自动降级为「未配置」
    @Inject(LarkClient)
    @Optional()
    private readonly lark?: LarkClient,
  ) {
    this.receiveId = config.lark?.receiveId
    this.receiveIdType = config.lark?.receiveIdType ?? 'open_id'
  }

  get configured(): boolean {
    return Boolean(this.receiveId && this.lark)
  }

  async send(payload: NotifyPayload): Promise<SendResult> {
    if (!this.receiveId || !this.lark) {
      return { ok: false, error: '通道未配置：lark' }
    }
    if (!('content' in payload)) {
      return { ok: false, error: '飞书通知仅支持文本消息（content）' }
    }
    try {
      await this.lark.raw.im.message.create({
        params: { receive_id_type: this.receiveIdType },
        data: {
          receive_id: this.receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text: payload.content }),
        },
      })
      return { ok: true }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.logger.error('飞书通知发送失败', { receiveIdType: this.receiveIdType, error: message })
      return { ok: false, error: message }
    }
  }
}
