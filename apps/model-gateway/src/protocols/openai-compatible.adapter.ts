import { Injectable } from '@nestjs/common'
import type { GatewayProtocol } from '@repo/contracts'
import { AiProviderProtocol } from '@repo/shared'
import { buildOpenAiRequest, type ProtocolAdapter, type UpstreamRequest } from './types.js'
import type { GatewayTarget } from '../catalog/model.catalog.service.js'
import type { GatewayChatBody } from '@repo/contracts'

/**
 * OpenAI 兼容族（Kimi / 豆包 / 千问 / 智谱 / 硅基 / 自建…）。
 *
 * 只做「换地址 + 换密钥 + 替换 model」，请求/响应字节透传；
 * 上游的 `reasoning_content` / `reasoning` 原样保留。
 */
@Injectable()
export class OpenAiCompatibleAdapter implements ProtocolAdapter {
  readonly protocol: GatewayProtocol = AiProviderProtocol.OpenaiCompatible

  buildRequest(input: { body: GatewayChatBody; target: GatewayTarget }): UpstreamRequest {
    return buildOpenAiRequest(input)
  }
}
