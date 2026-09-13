import { AppLogger } from '../foundation/logger/app-logger.js'
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common'
import { Kafka, logLevel, type Consumer, type KafkaConfig as KafkaJsConfig, type Producer } from 'kafkajs'
import pRetry from 'p-retry'
import { coalesceAsync } from 'promise-coalesce'
import { KafkaConfig, type KafkaConfig as KafkaConfigType } from './kafka.config.js'
import { KAFKA_CONNECTION } from './kafka.providers.js'

/** topic / 消费组命名选项 */
export interface KafkaNameOptions {
  /** 是否套用 topicPrefix，默认 true */
  usePrefix?: boolean
  /** 消费组后缀（同一 topic 多消费组时区分），默认 'default' */
  suffix?: string
}

const defaultNameOptions: KafkaNameOptions = { usePrefix: true }

/**
 * Kafka 生产 / 消费门面（kafkajs 封装）。
 *
 * - 生产者：`send(topic, payload, key?)`，内置 3 次重试；
 * - 消费者：业务用 `@KafkaConsumer(topic)` 标注方法，由 KafkaConsumerScanner 启动时自动订阅；
 * - topic / groupId 按配置加前缀，避免多环境共用集群时串topic；
 * - 与应用生命周期绑定：`onApplicationShutdown` 统一断开全部生产者 / 消费者。
 *
 * 归位：横切基础能力 → `packages/kits/src/kafka/`（只在导入 `KafkaModule.forRoot(...)` 时装配：未装配则无 Kafka provider）。
 */
@Injectable()
export class KafkaService implements OnApplicationShutdown {

  private readonly producers = new Map<string, Producer>()
  private readonly consumers = new Map<string, Consumer>()

  constructor(
    @Inject(KAFKA_CONNECTION) private readonly kafka: Kafka,
    @Inject(KafkaConfig) private readonly config: KafkaConfigType,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 业务 topic 名 → 实际 topic 名（按配置加前缀） */
  formatTopicName(name: string, usePrefix = true): string {
    const prefix = this.config.topicPrefix
    return usePrefix && prefix ? `${prefix}.${name}` : name
  }

  /** 实际 topic 名 → 消费组 id */
  formatGroupId(topicName: string, suffix?: string): string {
    return `${this.config.groupIdPrefix}-${topicName}-${suffix ?? 'default'}`
  }

  /** 取（并按需创建）指定 topic 的生产者；同一 topic 复用同一连接 */
  getProducer(topic: string): Promise<Producer> {
    const cached = this.producers.get(topic)
    if (cached) return Promise.resolve(cached)

    return coalesceAsync(`kafka-producer:${topic}`, async () => {
      const existing = this.producers.get(topic)
      if (existing) return existing
      const producer = this.kafka.producer()
      await producer.connect()
      this.producers.set(topic, producer)
      this.logger.info('Kafka 生产者已连接', { topic })
      return producer
    })
  }

  /** 取（并按需创建、订阅）指定 topic 的消费者；同名 + 同后缀复用 */
  getConsumer(topic: string, options: KafkaNameOptions = defaultNameOptions): Promise<Consumer> {
    const topicName = this.formatTopicName(topic, options.usePrefix ?? true)
    const cacheKey = options.suffix ? `${topicName}-${options.suffix}` : topicName
    const cached = this.consumers.get(cacheKey)
    if (cached) return Promise.resolve(cached)

    return coalesceAsync(`kafka-consumer:${cacheKey}`, async () => {
      const existing = this.consumers.get(cacheKey)
      if (existing) return existing

      const groupId = this.formatGroupId(topicName, options.suffix)
      const consumer = this.kafka.consumer({
        groupId,
        sessionTimeout: 30_000,
        heartbeatInterval: 5_000,
        rebalanceTimeout: 60_000,
      })
      await consumer.connect()
      await consumer.subscribe({ topic: topicName, fromBeginning: false })
      this.consumers.set(cacheKey, consumer)
      this.logger.info('Kafka 消费者已订阅', { topic: topicName, groupId })
      return consumer
    })
  }

  /**
   * 发送消息：非字符串负载自动 JSON 序列化；失败重试 3 次（指数退避由 p-retry 默认提供）。
   */
  async send(
    topic: string,
    payload: unknown,
    key?: string,
    options: KafkaNameOptions = defaultNameOptions,
  ): Promise<void> {
    const topicName = this.formatTopicName(topic, options.usePrefix ?? true)
    const value = typeof payload === 'string' ? payload : JSON.stringify(payload)

    await pRetry(
      async () => {
        const producer = await this.getProducer(topic)
        await producer.send({ topic: topicName, messages: [{ value, key }] })
        this.logger.debug('Kafka 消息已发送', { topic: topicName, key })
      },
      {
        retries: 3,
        onFailedAttempt: (error) => {
          this.logger.warn('Kafka 消息发送失败，准备重试', {
            topic: topicName,
            attempt: error.attemptNumber,
            retriesLeft: error.retriesLeft,
          })
        },
      },
    )
  }

  /** 应用停止：断开全部生产者与消费者 */
  async onApplicationShutdown(): Promise<void> {
    const results = await Promise.allSettled([
      ...[...this.producers.values()].map((producer) => producer.disconnect()),
      ...[...this.consumers.values()].map((consumer) => consumer.disconnect()),
    ])
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length > 0) {
      this.logger.error('Kafka 连接关闭存在失败项', { failed: failed.length })
    }
    this.producers.clear()
    this.consumers.clear()
  }
}

/** 由 KafkaConfig 构造 kafkajs 客户端（`KafkaModule.forRoot` 构造时调用） */
export const createKafkaConnection = (config: KafkaConfigType): Kafka => {
  const options: KafkaJsConfig = {
    clientId: config.clientId,
    brokers: config.brokers,
    logLevel: logLevel.NOTHING,
  }
  return new Kafka(options)
}
