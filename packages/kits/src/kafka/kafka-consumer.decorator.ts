import { SetMetadata } from '@nestjs/common'
import { KAFKA_CONSUMER_METADATA, type KafkaConsumerMetadata } from './kafka.providers.js'

/**
 * 标记一个 provider 方法为 Kafka 消费者（由 KafkaConsumerScanner 在应用启动时自动订阅）。
 *
 *   @Injectable()
 *   export class OrderEventsConsumer {
 *     @KafkaConsumer('order.created')
 *     async onCreated(payload: unknown) { ... }
 *   }
 *
 * 方法签名：`(payload, topic, partition) => Promise<void> | void`，payload 为消息体 JSON 解析结果。
 * 同一 topic 需要多个独立消费组时用第二个参数区分（groupId 后缀）。
 */
export const KafkaConsumer = (topic: string, groupId?: string): MethodDecorator =>
  SetMetadata(KAFKA_CONSUMER_METADATA, { topic, groupId } satisfies KafkaConsumerMetadata)
