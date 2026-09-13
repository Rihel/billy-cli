import type { Kafka } from 'kafkajs'

/** Kafka 客户端实例（由 `KafkaModule.forRoot` 按 KafkaConfig 装配） */
export const KAFKA_CONNECTION = Symbol.for('KafkaConnection')

/** Kafka 客户端实例类型别名 */
export type KafkaConnection = Kafka

/** 消费者回调元数据 key（@KafkaConsumer 写入，扫描器读取） */
export const KAFKA_CONSUMER_METADATA = Symbol.for('KafkaConsumerMetadata')

export interface KafkaConsumerMetadata {
  topic: string
  /** 同一 topic 多消费者时的区分后缀（进入 groupId） */
  groupId?: string
}
