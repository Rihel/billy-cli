import { Global, Module } from '@nestjs/common'
import { QueueManager } from './queue.js'

/**
 * 队列模块（BullMQ）：无自有配置，复用 RedisModule 提供的 RedisConfig
 * （QueueManager 为每个队列 / Worker 建立独立连接，连接参数来自同一 Redis 配置）。
 */
@Global()
@Module({ providers: [QueueManager], exports: [QueueManager] })
export class QueueModule {}
