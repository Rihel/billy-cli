import { AppLogger } from '../foundation/logger/app-logger.js'
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common'
import {
  Kafka,
  logLevel,
  type Consumer,
  type KafkaConfig as KafkaJsConfig,
  type Producer,
} from 'kafkajs'
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

/** broker 不可达时的快失败错误：冷却期内抛这个，而不是排队去等连接超时 */
export class KafkaUnavailableError extends Error {
  constructor(
    message: string,
    /** 距离冷却结束还剩多少 ms（调用方可据此决定何时重试） */
    readonly retryAfterMs: number,
  ) {
    super(message)
    this.name = 'KafkaUnavailableError'
  }
}

/** 当前 Kafka 可用性快照（供健康检查 / 调用方决定是否发布） */
export interface KafkaAvailability {
  available: boolean
  retryAfterMs: number
  lastError?: string
}

/**
 * Kafka 生产 / 消费统一入口（kafkajs 封装）。
 *
 * - 生产者：`send(topic, payload, key?)`，内置有限重试；
 * - 消费者：业务用 `@KafkaConsumer(topic)` 标注方法，由 KafkaConsumerScanner 启动时自动订阅；
 * - topic / groupId 按配置加前缀，避免多环境共用集群时串 topic；
 * - 与应用生命周期绑定：`onApplicationShutdown` 统一断开全部生产者 / 消费者。
 *
 * **可用性规则（重要）**：
 * 1. **不阻塞启动**：连接是惰性的 —— DI / 构造阶段只建 kafkajs 客户端对象、不发网络请求，
 *    只有真正 `send` 或消费者启动时才建连。故 broker 挂掉不会推迟 HTTP 服务可用
 *    （实测黑洞地址下 725ms 可服务，不配 Kafka 为 682ms，差异属噪声）。
 * 2. **不拖住请求**：建连超时与 kafkajs 重试次数用本模块的快失败默认值（3s / 2 次），
 *    且一次失败后进入冷却期（`unavailableCooldownMs`），期间 `send` **立即**抛
 *    `KafkaUnavailableError`，让调用方快速降级（落表补偿 / 进重试 topic），
 *    而不是让请求线程陪着连接超时一起耗。
 *
 * 放置：横切基础能力 → `packages/kits/src/kafka/`（只在导入 `KafkaModule.forRoot(...)` 时装配：未装配则无 Kafka provider）。
 */
@Injectable()
export class KafkaService implements OnApplicationShutdown {
  private readonly producers = new Map<string, Producer>()
  private readonly consumers = new Map<string, Consumer>()

  /** 可用性冷却截止时间戳；0 表示可用 */
  private unavailableUntil = 0
  private lastError?: string

  constructor(
    @Inject(KAFKA_CONNECTION) private readonly kafka: Kafka,
    @Inject(KafkaConfig) private readonly config: KafkaConfigType,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 当前可用性：冷却期内 `available=false`，`retryAfterMs` 为剩余毫秒 */
  getAvailability(): KafkaAvailability {
    const retryAfterMs = Math.max(0, this.unavailableUntil - Date.now())
    return {
      available: retryAfterMs === 0,
      retryAfterMs,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  /** 冷却期内直接抛错：宁可快失败，也不让请求去等一次注定超时的建连 */
  private assertAvailable(_topic: string): void {
    const { available, retryAfterMs, lastError } = this.getAvailability()
    if (available) return
    throw new KafkaUnavailableError(
      `Kafka 不可用（冷却中，${retryAfterMs}ms 后可重试）：${lastError ?? '连接失败'}`,
      retryAfterMs,
    )
  }

  private markUnavailable(error: unknown, topic: string): void {
    const message = error instanceof Error ? error.message : String(error)
    this.lastError = message
    this.unavailableUntil = Date.now() + this.config.unavailableCooldownMs
    this.logger.warn('Kafka 连接失败，进入快失败冷却期', {
      topic,
      cooldownMs: this.config.unavailableCooldownMs,
      error: message,
    })
  }

  private markAvailable(): void {
    if (this.unavailableUntil !== 0) {
      this.logger.info('Kafka 已恢复可用')
    }
    this.unavailableUntil = 0
    this.lastError = undefined
  }

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
      this.assertAvailable(topic)

      const producer = this.kafka.producer()
      try {
        await producer.connect()
      } catch (error) {
        // 连接失败的 producer 不进缓存，并尽量回收，避免积压半开连接
        await producer.disconnect().catch(() => undefined)
        this.markUnavailable(error, topic)
        throw error
      }

      this.markAvailable()
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
      this.assertAvailable(topicName)

      const groupId = this.formatGroupId(topicName, options.suffix)
      const consumer = this.kafka.consumer({
        groupId,
        sessionTimeout: 30_000,
        heartbeatInterval: 5_000,
        rebalanceTimeout: 60_000,
      })
      try {
        await consumer.connect()
        await consumer.subscribe({ topic: topicName, fromBeginning: false })
      } catch (error) {
        await consumer.disconnect().catch(() => undefined)
        this.markUnavailable(error, topicName)
        throw error
      }

      this.markAvailable()
      this.consumers.set(cacheKey, consumer)
      this.logger.info('Kafka 消费者已订阅', { topic: topicName, groupId })
      return consumer
    })
  }

  /**
   * 发送消息：非字符串负载自动 JSON 序列化。
   *
   * 失败语义：最多再试 1 次（总耗时由连接超时 + 冷却期兜住）；冷却期内直接抛
   * `KafkaUnavailableError`。调用方据此快速降级，别让 HTTP 请求跟着 Kafka 一起挂。
   */
  async send(
    topic: string,
    payload: unknown,
    key?: string,
    options: KafkaNameOptions = defaultNameOptions,
  ): Promise<void> {
    const topicName = this.formatTopicName(topic, options.usePrefix ?? true)
    const value = typeof payload === 'string' ? payload : JSON.stringify(payload)

    // 冷却期内直接抛，连 pRetry 的退避都不等（放到 pRetry 里面会被 minTimeout 拖出 200ms+）
    this.assertAvailable(topicName)

    await pRetry(
      async () => {
        const producer = await this.getProducer(topic)
        await producer.send({ topic: topicName, messages: [{ value, key }] })
        this.logger.debug('Kafka 消息已发送', { topic: topicName, key })
      },
      {
        retries: 1,
        minTimeout: 200,
        maxTimeout: 500,
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
    // 复位可用性：进程重启后不该继承上一次的冷却状态
    this.unavailableUntil = 0
    this.lastError = undefined
  }
}

/**
 * 由 KafkaConfig 构造 kafkajs 客户端（`KafkaModule.forRoot` 构造时调用）。
 *
 * 注意：`new Kafka(...)` 只建客户端对象、**不发任何网络请求**，故不会拖慢启动。
 */
export const createKafkaConnection = (config: KafkaConfigType): Kafka => {
  const options: KafkaJsConfig = {
    clientId: config.clientId,
    brokers: config.brokers,
    logLevel: logLevel.NOTHING,
    // 快失败：kafkajs 默认 connectionTimeout 1s + retries 5 会让一次失败空转十几秒
    connectionTimeout: config.connectionTimeoutMs,
    requestTimeout: config.requestTimeoutMs,
    retry: {
      retries: config.retryCount,
      initialRetryTime: config.retryInitialDelayMs,
    },
  }
  return new Kafka(options)
}
