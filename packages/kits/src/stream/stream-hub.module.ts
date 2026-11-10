import { Global, Module } from '@nestjs/common'
import { StreamHub } from './stream-hub.js'

/**
 * 服务端推流模块（SSE，多实例广播）：无自有配置。
 * 广播传输（Redis 连接 / 重连 / 自回环过滤）由 `PubSubModule` 提供。
 */
@Global()
@Module({ providers: [StreamHub], exports: [StreamHub] })
export class StreamHubModule {}
