import { AppLogger } from '../foundation/logger/app-logger.js'
import { parseJson } from '@repo/shared'
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { DiscoveryService, MetadataScanner } from '@nestjs/core'
import pLimit from 'p-limit'
import pRetry from 'p-retry'
import { coalesceAsync } from 'promise-coalesce'
import { KafkaConfig, type KafkaConfig as KafkaConfigType } from './kafka.config.js'
import {
  KAFKA_CONSUMER_METADATA,
  type KafkaConsumerMetadata,
} from './kafka.providers.js'
import { KafkaService } from './kafka.service.js'

type ConsumerCallback = (
  payload: unknown,
  topic: string,
  partition: number,
) => Promise<void> | void

interface ConsumerGroup {
  metadata: KafkaConsumerMetadata
  callbacks: Set<ConsumerCallback>
}

/** 扫描时跳过的 Nest 生命周期方法（避免误绑） */
const EXCLUDED_METHODS = new Set([
  'constructor',
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'onApplicationShutdown',
  'beforeApplicationShutdown',
])

/**
 * Kafka 消费者扫描器：应用启动时扫描全部 provider 上被 `@KafkaConsumer(topic)` 标注的方法，
 * 按 topic（+ 可选 groupId 后缀）分组，为每组建立消费者并按消息分发（同一组内多方法都会收到）。
 *
 * **不阻塞启动（必须保持）**：`onApplicationBootstrap` 只做**同步的元数据扫描**，
 * 真正的建连 / 订阅 (`startConsumers`) 是后台浮动 Promise，绝不 await ——
 * 否则 broker 不可达时（kafkajs 建连 + 重试可耗十几秒）整个 HTTP 服务都会被拖住。
 * 改动本类时不要把 `onApplicationBootstrap` 变成 `async`。
 *
 * 失败策略：消费者启动失败重试 5 次（后台进行）；单条消息处理异常只记录日志，不中断消费循环。
 * 注意：若 5 次重试后仍失败，本进程内**不会**再自动重试 —— Kafka 恢复后需重启服务
 * （或后续补一个后台重连循环）。
 *
 * 依赖 DiscoveryModule（`KafkaModule.forRoot` 已 imports）。
 */
@Injectable()
export class KafkaConsumerScanner implements OnApplicationBootstrap {

  /** cacheKey（topic 或 topic:groupId）→ 消费者分组 */
  private readonly groups = new Map<string, ConsumerGroup>()

  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly metadataScanner: MetadataScanner,
    @Inject(KafkaService) private readonly kafkaService: KafkaService,
    @Inject(KafkaConfig) private readonly config: KafkaConfigType,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 同步返回：Nest 只 await 本方法的返回值，故这里**不能**变成 async（见类注释） */
  onApplicationBootstrap(): void {
    this.collectConsumers()
    void this.startConsumers()
  }

  /** 收集全部 @KafkaConsumer 标注的方法，按 topic（+ 后缀）分组 */
  private collectConsumers(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined
      if (!instance) continue

      const prototype = Object.getPrototypeOf(instance) as object | null
      if (!prototype) continue

      for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
        if (EXCLUDED_METHODS.has(methodName)) continue

        const method = (prototype as Record<string, unknown>)[methodName]
        const metadata = Reflect.getMetadata(
          KAFKA_CONSUMER_METADATA,
          method as object,
        ) as KafkaConsumerMetadata | undefined
        if (!metadata) continue

        const cacheKey = metadata.groupId
          ? `${metadata.topic}:${metadata.groupId}`
          : metadata.topic

        let group = this.groups.get(cacheKey)
        if (!group) {
          group = { metadata, callbacks: new Set() }
          this.groups.set(cacheKey, group)
        }
        group.callbacks.add(
          (method as ConsumerCallback).bind(instance) as ConsumerCallback,
        )
      }
    }

    this.logger.info('Kafka 消费者扫描完成', { groups: this.groups.size })
  }

  /** 启动全部消费者：并发受限 + 失败重试，避免启动风暴与瞬时抖动 */
  private async startConsumers(): Promise<void> {
    const limit = pLimit(this.config.consumerConcurrency)

    const tasks = [...this.groups.entries()]
      .filter(([, group]) => group.callbacks.size > 0)
      .map(([cacheKey, group]) =>
        limit(() =>
          coalesceAsync(`kafka-start:${cacheKey}`, () =>
            pRetry(
              async () => {
                const consumer = await this.kafkaService.getConsumer(
                  group.metadata.topic,
                  { usePrefix: true, suffix: group.metadata.groupId },
                )
                await consumer.run({
                  eachMessage: async ({ topic, partition, message }) => {
                    const raw = message.value?.toString()
                    for (const callback of group.callbacks) {
                      try {
                        const payload = raw ? parseJson(raw) : null
                        await callback(payload, topic, partition)
                      } catch (error) {
                        this.logger.error('Kafka 消息处理失败', {
                          consumer: cacheKey,
                          topic,
                          partition,
                          error,
                        })
                      }
                    }
                  },
                })
                this.logger.info('Kafka 消费者已启动', { consumer: cacheKey })
              },
              {
                retries: 5,
                onFailedAttempt: (error) => {
                  this.logger.warn('Kafka 消费者启动失败，准备重试', {
                    consumer: cacheKey,
                    attempt: error.attemptNumber,
                    retriesLeft: error.retriesLeft,
                  })
                },
              },
            ),
          ),
        ),
      )

    const results = await Promise.allSettled(tasks)
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length > 0) {
      this.logger.error('Kafka 消费者启动存在失败项', {
        failed: failed.length,
        hint: 'Kafka 不可用；本进程不会再自动重试，恢复后需重启服务',
      })
    }
  }
}
