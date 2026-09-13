import { Global, Module } from '@nestjs/common'
import { StreamHub } from './stream-hub.js'

/**
 * 服务端推流模块（SSE，多实例 Redis pub/sub 广播）：无自有配置，
 * 复用 RedisModule 的 RedisConfig，并注入 IdGenerationModule 的 IdGeneration。
 */
@Global()
@Module({ providers: [StreamHub], exports: [StreamHub] })
export class StreamHubModule {}
