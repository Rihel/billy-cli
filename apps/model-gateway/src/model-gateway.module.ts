import { Module } from '@nestjs/common'
import { APP_PIPE } from '@nestjs/core'
import { ConfigService } from '@nestjs/config'
import { createZodValidationPipe } from '@repo/kits'
import { ModelChangeSubscriber } from './cache/model-change.subscriber.js'
import { ProviderProbeController } from './sync/provider-probe.controller.js'
import { ProviderProbeService } from './sync/provider-probe.service.js'
import { CatalogController } from './catalog/catalog.controller.js'
import { ModelCatalogService } from './catalog/model.catalog.service.js'
import { ChatController } from './chat/chat.controller.js'
import { ChatService } from './chat/chat.service.js'
import { ModelGatewayConfig, type ModelGatewayConfigValue } from './config/app-config.js'
import { HealthController } from './health/health.controller.js'
import { AnthropicAdapter } from './protocols/anthropic.adapter.js'
import { DeepSeekAdapter } from './protocols/deepseek.adapter.js'
import { OllamaAdapter } from './protocols/ollama.adapter.js'
import { OpenAiCompatibleAdapter } from './protocols/openai-compatible.adapter.js'
import { ProviderKeyService } from './keys/provider-key.service.js'
import { ProtocolRegistry } from './protocols/registry.js'
import { UsageRecorder } from './usage/usage-recorder.service.js'

/** 模型网关：目录 + 4 套协议适配 + 对话代理；不含任何业务控制器 */
@Module({
  controllers: [CatalogController, ChatController, HealthController, ProviderProbeController],
  providers: [
    // 全局 Zod 校验：控制器上的 `@Body({ schema })` 由它读取
    { provide: APP_PIPE, useFactory: createZodValidationPipe },
    {
      provide: ModelGatewayConfig,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ModelGatewayConfigValue =>
        config.getOrThrow<ModelGatewayConfigValue>('gateway'),
    },
    ModelCatalogService,
    OpenAiCompatibleAdapter,
    DeepSeekAdapter,
    AnthropicAdapter,
    OllamaAdapter,
    ProtocolRegistry,
    ProviderKeyService,
    UsageRecorder,
    ModelChangeSubscriber,
    ProviderProbeService,
    ChatService,
  ],
})
export class ModelGatewayModule {}
