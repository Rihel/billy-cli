import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import type { AppLogger } from '../src/foundation/logger/app-logger.js'
import { KafkaConfigSchema } from '../src/kafka/kafka.config.js'
import { KAFKA_CONSUMER_METADATA } from '../src/kafka/kafka.providers.js'
import { KafkaConsumerScanner } from '../src/kafka/kafka-consumer-scanner.js'
import {
  KafkaService,
  KafkaUnavailableError,
  createKafkaConnection,
} from '../src/kafka/kafka.service.js'

/** 记录日志调用的假 logger（只关心调用，不关心 pino 输出） */
const makeFakeLogger = (): AppLogger => {
  const calls: string[] = []
  const logger = {
    calls,
    info: () => calls.push('info'),
    warn: () => calls.push('warn'),
    error: () => calls.push('error'),
    debug: () => calls.push('debug'),
  }
  return logger as unknown as AppLogger
}

/** 无人监听的地址：连不上但立刻 ECONNREFUSED，适合测「快失败」 */
const DEAD_BROKER = '127.0.0.1:1'

const deadBrokerConfig = () =>
  KafkaConfigSchema.parse({
    brokers: DEAD_BROKER,
    connectionTimeoutMs: 500,
    retryCount: 0,
    unavailableCooldownMs: 5_000,
  })

describe('Kafka 启动不被阻塞', () => {
  it('onApplicationBootstrap 同步返回，且不等 Kafka 建连（Nest 只 await 它的返回值）', async () => {
    // 消费者元数据直接写入（与 @KafkaConsumer 装饰器等价：装饰器就是 SetMetadata）。
    // 注意：kits 的 vitest 环境解析不了装饰器语法，故测试里不用装饰器。
    class ProbeConsumer {
      async onMessage(): Promise<void> {}
    }
    Reflect.defineMetadata(
      KAFKA_CONSUMER_METADATA,
      { topic: 'probe.topic' },
      ProbeConsumer.prototype.onMessage,
    )

    // 故意让建连悬挂：若扫描器 await 了它，本用例的同步断言就会失败
    let releaseConsumer: ((value: unknown) => void) | undefined
    const pendingConsumer = new Promise((resolve) => {
      releaseConsumer = resolve
    })
    let getConsumerCalls = 0
    const fakeKafkaService = {
      getConsumer: () => {
        getConsumerCalls += 1
        return pendingConsumer
      },
    }
    const fakeDiscovery = {
      getProviders: () => [{ instance: new ProbeConsumer() }],
    }
    const fakeMetadataScanner = {
      getAllMethodNames: () => ['onMessage'],
    }

    const scanner = new KafkaConsumerScanner(
      fakeDiscovery as never,
      fakeMetadataScanner as never,
      fakeKafkaService as never,
      deadBrokerConfig(),
      makeFakeLogger(),
    )

    const startedAt = Date.now()
    const returned = scanner.onApplicationBootstrap()

    // 关键：同步返回 undefined —— 若改成 async / 返回 Promise，Nest 会 await 它，启动就被 Kafka 拖住
    expect(returned).toBeUndefined()
    expect(Date.now() - startedAt).toBeLessThan(50)
    // 但建连确实在后台发起了（不是被吞掉）
    await vi.waitFor(() => expect(getConsumerCalls).toBe(1))

    // 放行悬挂的建连，避免测试残留未决 Promise
    releaseConsumer?.({ run: async () => {}, disconnect: async () => {} })
    await vi.waitFor(() => expect(getConsumerCalls).toBe(1))
  })

  it('构造 kafkajs 客户端不发网络请求（broker 不可达也瞬间返回）', () => {
    const startedAt = Date.now()
    const connection = createKafkaConnection(deadBrokerConfig())
    expect(connection).toBeDefined()
    expect(Date.now() - startedAt).toBeLessThan(50)
  })
})

describe('Kafka broker 不可用时的快失败', () => {
  it('send 有界失败（不会拖到 kafkajs 默认的十几秒），随后进入冷却期立即失败', async () => {
    const config = deadBrokerConfig()
    const service = new KafkaService(
      createKafkaConnection(config),
      config,
      makeFakeLogger(),
    )

    const firstStartedAt = Date.now()
    await expect(service.send('probe.topic', { hello: 'world' })).rejects.toThrow()
    const firstMs = Date.now() - firstStartedAt
    expect(firstMs).toBeLessThan(5_000)
    expect(service.getAvailability().available).toBe(false)

    // 冷却期内：立即失败（不再去等连接超时）
    const secondStartedAt = Date.now()
    await expect(service.send('probe.topic', { hello: 'world' })).rejects.toThrow(
      KafkaUnavailableError,
    )
    expect(Date.now() - secondStartedAt).toBeLessThan(150)

    await service.onApplicationShutdown()
    // 关闭后复位可用性，避免重启继承冷却
    expect(service.getAvailability().available).toBe(true)
  }, 20_000)
})

describe('KafkaConfig 快失败默认值', () => {
  it('默认值面向「不拖住启动与请求」', () => {
    const config = KafkaConfigSchema.parse({ brokers: DEAD_BROKER })
    expect(config.connectionTimeoutMs).toBe(3_000)
    expect(config.requestTimeoutMs).toBe(15_000)
    expect(config.retryCount).toBe(2)
    expect(config.retryInitialDelayMs).toBe(300)
    expect(config.unavailableCooldownMs).toBe(5_000)
  })

  it('brokers 支持逗号分隔字符串', () => {
    const config = KafkaConfigSchema.parse({ brokers: 'a:9092, b:9092' })
    expect(config.brokers).toEqual(['a:9092', 'b:9092'])
  })
})
