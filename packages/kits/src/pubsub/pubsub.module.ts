import { Global, Module } from '@nestjs/common'
import { PubSub } from './pubsub.js'

/**
 * 底层 Pub/Sub 传输模块：**无自有配置**，复用 RedisModule 的 `RedisConfig`
 * 与 IdGenerationModule 的 `IdGeneration`。
 *
 * 谁需要跨实例广播，谁就注入 `PubSub`：
 * - `StreamHub`（SSE，`stream:` 前缀 + 模式订阅）；
 * - `EventBus`（领域事件 / 失效通知，`events:` 前缀 + 精确订阅）。
 *
 * 连接是惰性的（第一次 broadcast / subscribe 才建），不与具体消费者生命周期绑定。
 */
@Global()
@Module({ providers: [PubSub], exports: [PubSub] })
export class PubSubModule {}
