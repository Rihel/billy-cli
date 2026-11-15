import { AGENT_RUN_EVENT_TOPIC } from '@repo/shared'
import { describe, expect, it, vi } from 'vitest'
import { AgentStreamStore } from '../src/modules/ai/runtime/stream-store.service.js'

/**
 * 输出片段的**传输分流**（2026-11-15 OOM 回归）。
 *
 * 事故：断线重连既 `publishChunk` 到 Redis 频道、又订阅同一条频道，订阅回调里再转发 ——
 * 自己发自己收，一次重连就把 Kafka 生产队列堆到 GB 级，runtime 直接 4GB 堆 OOM。
 *
 * 现在的口径：
 * - 装了 Kafka：runtime 的输出**只走 Kafka**（main 消费后写给前端），不再广播 Redis 频道；
 * - 没装 Kafka（直连模式）：才走 Redis 频道，供另一个 HTTP 请求（补发连接）接收实时片段；
 * - 补发用 `forwardChunk`：只发 Kafka，绝不回发 Redis 频道。
 */

const silentLogger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never

const makeRedis = () => ({ publish: vi.fn(async () => 1) })
const makeKafka = () => ({ send: vi.fn(async () => undefined), warmup: vi.fn() })

const chunkChannel = (runId: string): string => `agent:stream:${runId}:chunk`

describe('AgentStreamStore 传输分流', () => {
  it('Kafka 模式下 publishChunk 只发 Kafka，不再往 Redis 频道广播', async () => {
    const redis = makeRedis()
    const kafka = makeKafka()
    const store = new AgentStreamStore(redis as never, silentLogger, kafka as never)
    store.bindClient('run1', 'client1', 'conv1', 'user1')

    await store.publishChunk('run1', { type: 'text-delta', delta: 'hi' })

    expect(redis.publish).not.toHaveBeenCalled()
    expect(kafka.send).toHaveBeenCalledTimes(1)
    const [topic, event, key] = kafka.send.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string,
    ]
    expect(topic).toBe(AGENT_RUN_EVENT_TOPIC)
    expect(event).toMatchObject({
      runId: 'run1',
      clientId: 'client1',
      conversationId: 'conv1',
      ownerId: 'user1',
      final: false,
    })
    expect(event.chunk).toEqual({ type: 'text-delta', delta: 'hi' })
    expect(key).toBe('run1')
  })

  it('结束帧带 final=true，且发完即解绑（之后的片段不再发 Kafka）', async () => {
    const kafka = makeKafka()
    const store = new AgentStreamStore(makeRedis() as never, silentLogger, kafka as never)
    store.bindClient('run1', 'client1', 'conv1', 'user1')

    await store.publishChunk('run1', { type: '__run_end__' })
    const [, event] = kafka.send.mock.calls[0] as [string, Record<string, unknown>]
    expect(event.final).toBe(true)

    await store.publishChunk('run1', { type: 'text-delta' })
    expect(kafka.send).toHaveBeenCalledTimes(1)
  })

  it('未装配 Kafka（直连模式）时 publishChunk 走 Redis 频道', async () => {
    const redis = makeRedis()
    const store = new AgentStreamStore(redis as never, silentLogger)

    await store.publishChunk('run1', { type: 'text-delta', delta: 'hi' })

    expect(redis.publish).toHaveBeenCalledWith(
      chunkChannel('run1'),
      JSON.stringify({ type: 'text-delta', delta: 'hi' }),
    )
  })

  it('forwardChunk 只发 Kafka、绝不回发 Redis 频道（补发不再自激回环）', async () => {
    const redis = makeRedis()
    const kafka = makeKafka()
    const store = new AgentStreamStore(redis as never, silentLogger, kafka as never)
    store.bindClient('run1', 'client1', 'conv1', 'user1')

    await store.forwardChunk('run1', { type: 'text-delta' })

    expect(redis.publish).not.toHaveBeenCalled()
    expect(kafka.send).toHaveBeenCalledTimes(1)
  })

  it('forwardChunk 在直连模式下不发任何东西（补发直接写 HTTP 响应）', async () => {
    const redis = makeRedis()
    const store = new AgentStreamStore(redis as never, silentLogger)

    await store.forwardChunk('run1', { type: 'text-delta' })

    expect(redis.publish).not.toHaveBeenCalled()
  })

  it('Kafka 模式但没绑定 clientId 时：不发 Kafka，也不退回 Redis', async () => {
    const redis = makeRedis()
    const kafka = makeKafka()
    const store = new AgentStreamStore(redis as never, silentLogger, kafka as never)

    await store.publishChunk('run1', { type: 'text-delta' })

    expect(kafka.send).not.toHaveBeenCalled()
    expect(redis.publish).not.toHaveBeenCalled()
  })

  it('kafkaEnabled 反映是否装配了 Kafka', () => {
    expect(new AgentStreamStore(makeRedis() as never, silentLogger).kafkaEnabled).toBe(false)
    expect(
      new AgentStreamStore(makeRedis() as never, silentLogger, makeKafka() as never).kafkaEnabled,
    ).toBe(true)
  })

  it('启动时预热生产者：同步调用 warmup，不 await（不阻塞启动）', () => {
    const kafka = makeKafka()
    const store = new AgentStreamStore(makeRedis() as never, silentLogger, kafka as never)

    expect(store.onApplicationBootstrap()).toBeUndefined()
    expect(kafka.warmup).toHaveBeenCalledTimes(1)
    expect(kafka.warmup).toHaveBeenCalledWith([AGENT_RUN_EVENT_TOPIC])
  })

  it('未装配 Kafka 时启动钩子是 no-op（直连模式）', () => {
    const store = new AgentStreamStore(makeRedis() as never, silentLogger)
    expect(() => store.onApplicationBootstrap()).not.toThrow()
  })
})
