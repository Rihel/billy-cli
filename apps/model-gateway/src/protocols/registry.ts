import { Inject, Injectable } from '@nestjs/common'
import type { GatewayProtocol } from '@repo/contracts'
import { AnthropicAdapter } from './anthropic.adapter.js'
import { DeepSeekAdapter } from './deepseek.adapter.js'
import { OllamaAdapter } from './ollama.adapter.js'
import { OpenAiCompatibleAdapter } from './openai-compatible.adapter.js'
import type { ProtocolAdapter } from './types.js'

/** 协议 → 适配器（4 套；加协议才改这里，加厂商只改画像表） */
@Injectable()
export class ProtocolRegistry {
  private readonly adapters: Map<string, ProtocolAdapter>

  constructor(
    @Inject(OpenAiCompatibleAdapter) openai: OpenAiCompatibleAdapter,
    @Inject(DeepSeekAdapter) deepseek: DeepSeekAdapter,
    @Inject(AnthropicAdapter) anthropic: AnthropicAdapter,
    @Inject(OllamaAdapter) ollama: OllamaAdapter,
  ) {
    this.adapters = new Map<string, ProtocolAdapter>(
      [openai, deepseek, anthropic, ollama].map((adapter) => [adapter.protocol, adapter]),
    )
  }

  get(protocol: GatewayProtocol | string): ProtocolAdapter {
    const adapter = this.adapters.get(protocol)
    if (!adapter) throw new Error(`未注册的模型协议：${protocol}`)
    return adapter
  }
}
