import { Global, Module } from '@nestjs/common'
import { EventBus } from './event-bus.js'

/**
 * 进程内事件总线：**无自有配置**。
 * 广播传输（Redis 连接 / 重连 / 自回环过滤）由 `PubSubModule` 提供。
 *
 * 与 `StreamHubModule` 同一形状：只提供 bean，生命周期由 Nest 驱动。
 */
@Global()
@Module({ providers: [EventBus], exports: [EventBus] })
export class EventBusModule {}
