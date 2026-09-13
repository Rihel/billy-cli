import { Inject, Injectable } from '@nestjs/common'
import * as lark from '@larksuiteoapi/node-sdk'
import { LarkConfig } from './lark.config.js'

/**
 * 飞书（Lark）客户端：官方 SDK（@larksuiteoapi/node-sdk）的封装 bean。
 *
 * 独立模块：负责官方 Client 的创建（App 凭证 / 域），暴露 `raw` 供业务调用完整飞书 API
 * （im.message 等）。与其它基础设施模块平级；可独立注入使用。
 * 通知语义（发消息到群 / 用户）由 `LarkNotifyClient`（注入本客户端）实现。
 */
@Injectable()
export class LarkClient {
  /** 官方 SDK 客户端实例（业务可调 im / contact / drive 等完整能力） */
  readonly raw: lark.Client

  constructor(@Inject(LarkConfig) config: LarkConfig) {
    this.raw = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: config.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    })
  }
}
