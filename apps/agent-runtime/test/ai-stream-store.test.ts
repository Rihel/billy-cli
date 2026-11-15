import { describe, expect, it, vi } from 'vitest'
import { AgentStreamStore } from '../src/modules/ai/runtime/stream-store.service.js'

/**
 * 输出片段的**定向转发**（2026-11-15 Kafka 事故后重写）。
 *
 * 事故：断线重连既 `publishChunk` 到 Redis 频道、又订阅同一条频道，订阅回调里再转发 ——
 * 自己发自己收，一次重连就把生产队列堆到 GB 级，runtime 直接 4GB 堆 OOM。
 *
 * 现在的口径：
 * - 片段只发到 `agent:stream:client:<clientId>`（收件地址存在进度 Hash 里，跨副本可读）；
 * - 补发帧与实时帧走同一条频道，**只发不订阅**；
 * - 订阅只用于「跨副本停止信号」。
 */

const silentLogger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never

const makeRedis = (bound: string | null = null) => ({
  hget: vi.fn(async () => bound),
  hset: vi.fn(async () => 1),
  expire: vi.fn(async () => true),
  publish: vi.fn(async () => 1),
})

const makePubSub = () => ({
  broadcast: vi.fn(async () => true),
  subscribe: vi.fn(() => () => undefined),
})

const channelOf = (clientId: string): string => `agent:stream:client:${clientId}`
const stopChannelOf = (runId: string): string => `agent:stream:${runId}:stop`

describe('AgentStreamStore 定向转发', () => {
  it('把 clientId 写进进度 Hash 并带 TTL（跨副本可读，不吃进程内缓存）', async () => {
    const redis = makeRedis()
    const store = new AgentStreamStore(redis as never, silentLogger, makePubSub() as never)

    await store.bindClient('run1', 'client1')

    expect(redis.hset).toHaveBeenCalledWith('agent:run:run1', { clientId: 'client1' })
    expect(redis.expire).toHaveBeenCalledWith('agent:run:run1', 6 * 60 * 60)
  })

  it('publishChunk 发到该 clientId 的频道，帧里带 runId / chunk / final', async () => {
    const redis = makeRedis('client1')
    const pubsub = makePubSub()
    const store = new AgentStreamStore(redis as never, silentLogger, pubsub as never)

    await store.publishChunk('run1', { type: 'text-delta', delta: 'hi' })

    expect(redis.hget).toHaveBeenCalledWith('agent:run:run1', 'clientId')
    const [channel, frame] = pubsub.broadcast.mock.calls[0] as [string, Record<string, unknown>]
    expect(channel).toBe(channelOf('client1'))
    expect(frame).toMatchObject({ version: 1, runId: 'run1', final: false })
    expect(frame.chunk).toEqual({ type: 'text-delta', delta: 'hi' })
  })

  it('结束帧带 final=true', async () => {
    const pubsub = makePubSub()
    const store = new AgentStreamStore(makeRedis('client1') as never, silentLogger, pubsub as never)

    await store.publishChunk('run1', { type: '__run_end__' })

    const [, frame] = pubsub.broadcast.mock.calls[0] as [string, Record<string, unknown>]
    expect(frame.final).toBe(true)
  })

  it('没有绑定 clientId 时不发任何东西（没人要实时片段）', async () => {
    const pubsub = makePubSub()
    const store = new AgentStreamStore(makeRedis(null) as never, silentLogger, pubsub as never)

    await store.publishChunk('run1', { type: 'text-delta' })

    expect(pubsub.broadcast).not.toHaveBeenCalled()
  })

  it('publishControl 先发应答帧、再发 final 收尾帧', async () => {
    const pubsub = makePubSub()
    const store = new AgentStreamStore(makeRedis() as never, silentLogger, pubsub as never)

    await store.publishControl(
      { clientId: 'client1', runId: 'queue1' },
      { type: 'data-queue', data: {} },
    )

    expect(pubsub.broadcast.mock.calls.map(([channel]) => channel)).toEqual([
      channelOf('client1'),
      channelOf('client1'),
    ])
    const [, closing] = pubsub.broadcast.mock.calls[1] as [string, Record<string, unknown>]
    expect(closing.final).toBe(true)
    expect(closing.chunk).toEqual({ type: '__run_end__' })
  })

  it('停止信号经 pub/sub 广播，订阅只订停止频道', async () => {
    const pubsub = makePubSub()
    const store = new AgentStreamStore(makeRedis() as never, silentLogger, pubsub as never)

    await store.publishStop('run1')
    expect(pubsub.broadcast).toHaveBeenCalledWith(stopChannelOf('run1'), { stop: true })

    const onStop = vi.fn()
    await store.subscribeStop('run1', onStop)
    expect(pubsub.subscribe.mock.calls[0]?.[0]).toBe(stopChannelOf('run1'))
  })
})
