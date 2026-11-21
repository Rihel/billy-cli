import { describe, expect, it, vi } from 'vitest'
import { AgentStreamStore } from '../src/modules/ai/runtime/stream-store.service.js'

/**
 * 输出事件的**定向转发与 rev 记录**（2026-11-15 Kafka 事故后重写，2026-11-17 升 AG-UI）。
 *
 * 事故：断线重连既 `publish` 到 Redis 频道、又订阅同一条频道，订阅回调里再转发 ——
 * 自己发自己收，一次重连就把生产队列堆到 GB 级，runtime 直接 4GB 堆 OOM。
 *
 * 现在的口径：
 * - 事件只发到 `agent:stream:client:<clientId>`（收件地址存在进度 Hash 里，跨副本可读）；
 * - 补发与实时事件走同一条频道，**只发不订阅**；补发走一次 pipeline；
 * - 水位用 `INCR` 的 rev，与 List 下标解耦（裁剪不会让它漂移）。
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
  broadcastMany: vi.fn(async (_channel: string, payloads: unknown[]) => payloads.length),
  subscribe: vi.fn(() => () => undefined),
})

/** 内存版 List + INCR：够测 `appendEvent` / `appendEvents` / `readEvents` 的 rev 语义 */
const makeListRedis = (seed: string[] = []) => {
  const items = [...seed]
  const counters = new Map<string, number>()
  const bump = (key: string, amount: number): number => {
    const next = (counters.get(key) ?? 0) + amount
    counters.set(key, next)
    return next
  }
  return {
    items,
    incr: vi.fn(async (key: string) => bump(key, 1)),
    incrBy: vi.fn(async (key: string, amount: number) => bump(key, amount)),
    rpush: vi.fn(async (_key: string, value: string) => {
      items.push(value)
      return items.length
    }),
    // 批量追加：一次调用写 N 条（顺序与入参一致）
    rpushMany: vi.fn(async (_key: string, values: string[]) => {
      items.push(...values)
      return items.length
    }),
    expire: vi.fn(async () => true),
    ltrim: vi.fn(async (_key: string, start: number, stop: number) => {
      items.splice(0, start)
      if (stop !== -1) items.splice(stop + 1)
      return 'OK'
    }),
    lpop: vi.fn(async () => items.shift() ?? null),
    lindex: vi.fn(async (_key: string, index: number) => items[index] ?? null),
    lrange: vi.fn(async (_key: string, start: number, stop: number) =>
      items.slice(start, stop === -1 ? undefined : stop + 1),
    ),
    hget: vi.fn(async () => null),
  }
}

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

  it('publishEvent 发到该 clientId 的频道，帧里带 version 2 / runId / event', async () => {
    const redis = makeRedis('client1')
    const pubsub = makePubSub()
    const store = new AgentStreamStore(redis as never, silentLogger, pubsub as never)

    await store.publishEvent('run1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'hi' })

    expect(redis.hget).toHaveBeenCalledWith('agent:run:run1', 'clientId')
    const [channel, frame] = pubsub.broadcast.mock.calls[0] as [string, Record<string, unknown>]
    expect(channel).toBe(channelOf('client1'))
    expect(frame).toMatchObject({ version: 2, runId: 'run1', final: false })
    expect(frame.event).toEqual({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'hi' })
  })

  it('RUN_FINISHED 带 final=true（不再依赖旧结束标记）', async () => {
    const pubsub = makePubSub()
    const store = new AgentStreamStore(makeRedis('client1') as never, silentLogger, pubsub as never)

    await store.publishEvent('run1', { type: 'RUN_FINISHED', threadId: 't', runId: 'run1' })

    const [, frame] = pubsub.broadcast.mock.calls[0] as [string, Record<string, unknown>]
    expect(frame.final).toBe(true)
  })

  it('没有绑定 clientId 时不发任何东西（没人要实时事件）', async () => {
    const pubsub = makePubSub()
    const store = new AgentStreamStore(makeRedis(null) as never, silentLogger, pubsub as never)

    await store.publishEvent('run1', { type: 'TEXT_MESSAGE_CONTENT' })

    expect(pubsub.broadcast).not.toHaveBeenCalled()
  })

  it('publishEvents 一次 pipeline 发多帧（补发不再逐条 await）', async () => {
    const pubsub = makePubSub()
    const store = new AgentStreamStore(makeRedis('client1') as never, silentLogger, pubsub as never)

    await store.publishEvents('run1', [
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: '1' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a', delta: '2' },
    ])

    expect(pubsub.broadcast).not.toHaveBeenCalled()
    expect(pubsub.broadcastMany).toHaveBeenCalledTimes(1)
    const [channel, frames] = pubsub.broadcastMany.mock.calls[0] as [
      string,
      Array<Record<string, unknown>>,
    ]
    expect(channel).toBe(channelOf('client1'))
    expect(frames).toHaveLength(2)
    expect(frames[0]?.event).toMatchObject({ delta: '1' })
  })

  it('publishControl 先发应答事件、再发 RUN_FINISHED 收尾帧', async () => {
    const pubsub = makePubSub()
    const store = new AgentStreamStore(makeRedis() as never, silentLogger, pubsub as never)

    await store.publishControl(
      { clientId: 'client1', runId: 'queue1', conversationId: 'conv-1' },
      { type: 'data-queue', data: {} },
    )

    expect(pubsub.broadcastMany).toHaveBeenCalledTimes(2)
    expect(pubsub.broadcastMany.mock.calls.map(([channel]) => channel)).toEqual([
      channelOf('client1'),
      channelOf('client1'),
    ])
    const [, closing] = pubsub.broadcastMany.mock.calls[1] as [
      string,
      Array<Record<string, unknown>>,
    ]
    expect(closing[0]?.final).toBe(true)
    expect((closing[0]?.event as { type?: string } | undefined)?.type).toBe('RUN_FINISHED')
    expect((closing[0]?.event as { threadId?: string } | undefined)?.threadId).toBe('conv-1')
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

describe('AgentStreamStore 补发闸门', () => {
  it('begin 后 wait 阻塞，end 后放行；计数支持并发补发', async () => {
    let count = 0
    const redis = {
      incr: async () => {
        count += 1
        return count
      },
      incrBy: async (_key: string, amount: number) => {
        count += amount
        return count
      },
      expire: async () => true,
      exists: async () => (count > 0 ? 1 : 0),
      del: async () => {
        count = 0
        return 1
      },
      hget: async () => null,
    }
    const store = new AgentStreamStore(redis as never, silentLogger, makePubSub() as never)

    await store.beginReplay('run1')
    await store.beginReplay('run1')
    let released = false
    const waiting = store.waitForReplayGate('run1').then(() => {
      released = true
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(released).toBe(false)

    await store.endReplay('run1')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(released).toBe(false)

    await store.endReplay('run1')
    await waiting
    expect(released).toBe(true)
  })
})

describe('AgentStreamStore 补发闸门（TTL 是唯一出口）', () => {
  /**
   * 旧实现等 15s 就"超时放行"，那是乱序根因；现在闸门只在键消失后放行，
   * 键的消失由 Redis TTL 保证。这条用假定时器把"15s 已过"跑出来，确认仍然不放行。
   */
  it('闸门未释放时不会因为等待时间到而放行', async () => {
    let count = 1
    const redis = {
      incr: async () => count,
      incrBy: async () => count,
      expire: async () => true,
      exists: async () => (count > 0 ? 1 : 0),
      del: async () => 1,
      hget: async () => null,
    }
    const store = new AgentStreamStore(redis as never, silentLogger, makePubSub() as never)

    vi.useFakeTimers()
    try {
      let released = false
      const waiting = store.waitForReplayGate('run1').then(() => {
        released = true
      })

      await vi.advanceTimersByTimeAsync(15_000)
      expect(released).toBe(false)

      // 补发结束（键消失）后才放行
      count = 0
      await vi.advanceTimersByTimeAsync(500)
      await waiting
      expect(released).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AgentStreamStore 输出记录（rev）', () => {
  it('appendEvent 用 INCR 的 rev，不拿下标当水位', async () => {
    const redis = makeListRedis()
    const store = new AgentStreamStore(redis as never, silentLogger, makePubSub() as never)

    expect(await store.appendEvent('run1', { type: 'TEXT_MESSAGE_START' })).toBe(1)
    expect(await store.appendEvent('run1', { type: 'TEXT_MESSAGE_END' })).toBe(2)

    expect(redis.rpushMany).toHaveBeenCalledWith('agent:stream:run1', [
      JSON.stringify({ rev: 1, event: { type: 'TEXT_MESSAGE_START' } }),
    ])
    expect(redis.rpushMany).toHaveBeenCalledWith('agent:stream:run1', [
      JSON.stringify({ rev: 2, event: { type: 'TEXT_MESSAGE_END' } }),
    ])
  })

  it('appendEvents 批量：rev 连续、一次 RPUSH 写多值、字节计数累计', async () => {
    const redis = makeListRedis()
    const store = new AgentStreamStore(redis as never, silentLogger, makePubSub() as never)

    const rev = await store.appendEvents('run1', [
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: '你' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: '好' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm' },
    ])

    // 一批拿到连续的 rev 段，返回最后一个
    expect(rev).toBe(3)
    expect(redis.rpushMany).toHaveBeenCalledTimes(1)
    const [, payloads] = redis.rpushMany.mock.calls[0] as [string, string[]]
    expect(payloads).toHaveLength(3)
    expect(payloads.map((item) => (JSON.parse(item) as { rev: number }).rev)).toEqual([1, 2, 3])
    // 一批只做一次 rev 段 + 一次字节计数（不是逐条 6 次往返）
    expect(redis.incrBy).toHaveBeenCalledTimes(2)
    expect(redis.incrBy).toHaveBeenCalledWith('agent:stream:run1:rev', 3)
    expect(redis.incrBy).toHaveBeenCalledWith('agent:stream:run1:bytes', expect.any(Number))

    // 第二批接着上一批的水位，不回退
    expect(await store.appendEvents('run1', [{ type: 'RUN_FINISHED' }])).toBe(4)
  })

  it('appendEvents 空数组不碰 Redis（收尾路径可能传空批）', async () => {
    const redis = makeListRedis()
    const store = new AgentStreamStore(redis as never, silentLogger, makePubSub() as never)

    expect(await store.appendEvents('run1', [])).toBe(0)
    expect(redis.rpushMany).not.toHaveBeenCalled()
    expect(redis.incrBy).not.toHaveBeenCalled()
  })

  it('readEvents 按 rev 切片，读侧把旧记录归一成 event', async () => {
    const redis = makeListRedis([
      JSON.stringify({ rev: 1, chunk: { type: 'text-start', id: 't1' } }),
      JSON.stringify({ type: 'text-delta', id: 't1', delta: '裸 chunk 旧记录' }),
      JSON.stringify({ rev: 3, event: { type: 'TEXT_MESSAGE_END', messageId: 't1' } }),
    ])
    const store = new AgentStreamStore(redis as never, silentLogger, makePubSub() as never)

    const records = await store.readEvents('run1', 2)

    expect(records).toEqual([
      { rev: 2, event: { type: 'text-delta', id: 't1', delta: '裸 chunk 旧记录' } },
      { rev: 3, event: { type: 'TEXT_MESSAGE_END', messageId: 't1' } },
    ])
  })

  it('空记录 readEvents 返回空数组（快照据此返回 rev=0）', async () => {
    const store = new AgentStreamStore(
      makeListRedis() as never,
      silentLogger,
      makePubSub() as never,
    )
    expect(await store.readEvents('run1', 0)).toEqual([])
  })
})
