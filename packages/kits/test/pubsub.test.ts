import { describe, expect, it, vi } from 'vitest'
import { PubSub } from '../src/pubsub/pubsub.js'
import { IdGeneration } from '../src/foundation/id-generation/id-generation.js'

/**
 * 底层 Pub/Sub 传输（ioredis 用替身）。
 *
 * 覆盖：广播载荷与频道、自回环过滤、精确 / 模式订阅、重连重订阅、退订、处理函数隔离。
 * 上层的 SSE（StreamHub）与事件总线（EventBus）另有自己的测试。
 */

const { FakeRedis, instances } = vi.hoisted(() => {
  class FakeRedis {
    static instances: FakeRedis[] = []
    status = 'wait'
    readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>()
    readonly published: Array<{ channel: string; payload: string }> = []
    readonly subscribed = new Set<string>()
    readonly psubscribed = new Set<string>()
    readonly unsubscribed: string[] = []
    readonly punsubscribed: string[] = []

    constructor(
      readonly url: string,
      readonly options?: unknown,
    ) {
      FakeRedis.instances.push(this)
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      let set = this.handlers.get(event)
      if (!set) {
        set = new Set()
        this.handlers.set(event, set)
      }
      set.add(handler)
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args)
    }

    async connect(): Promise<this> {
      this.status = 'ready'
      this.emit('ready')
      return this
    }

    async publish(channel: string, payload: string): Promise<number> {
      this.published.push({ channel, payload })
      return 1
    }

    async subscribe(channel: string): Promise<number> {
      this.subscribed.add(channel)
      return 1
    }

    async psubscribe(pattern: string): Promise<number> {
      this.psubscribed.add(pattern)
      return 1
    }

    async unsubscribe(channel: string): Promise<number> {
      this.subscribed.delete(channel)
      this.unsubscribed.push(channel)
      return 1
    }

    async punsubscribe(pattern: string): Promise<number> {
      this.psubscribed.delete(pattern)
      this.punsubscribed.push(pattern)
      return 1
    }

    async quit(): Promise<'OK'> {
      this.status = 'end'
      return 'OK'
    }

    disconnect(): void {
      this.status = 'end'
    }
  }
  return { FakeRedis, instances: FakeRedis.instances }
})

vi.mock('ioredis', () => ({ Redis: FakeRedis }))

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
}

const makePubSub = (): PubSub => {
  instances.length = 0
  return new PubSub({ url: 'redis://test' }, new IdGeneration(), logger as never)
}

/** 构造函数里先建 pub、再建 sub（顺序是稳定契约） */
const clients = () => ({ pub: instances[0]!, sub: instances[1]! })

describe('PubSub：广播', () => {
  it('broadcast 发到指定频道，载荷带实例 id / 频道 / 时间', async () => {
    const pubsub = makePubSub()
    const ok = await pubsub.broadcast('events:user.changed', { id: 'u1' })

    expect(ok).toBe(true)
    const { pub } = clients()
    expect(pub.published).toHaveLength(1)
    expect(pub.published[0]!.channel).toBe('events:user.changed')
    const envelope = JSON.parse(pub.published[0]!.payload) as Record<string, unknown>
    expect(envelope).toMatchObject({
      channel: 'events:user.changed',
      payload: { id: 'u1' },
      instanceId: pubsub.id,
    })
    expect(typeof envelope.publishedAt).toBe('number')
  })

  it('Redis 不可用返回 false，不抛错', async () => {
    const pubsub = makePubSub()
    const { pub } = clients()
    pub.publish = vi.fn(async () => {
      throw new Error('redis down')
    }) as never

    await expect(pubsub.broadcast('events:x', {})).resolves.toBe(false)
  })

  it('负载不能序列化时直接报错', async () => {
    const pubsub = makePubSub()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(pubsub.broadcast('events:x', circular)).rejects.toThrowError(/无法序列化为 JSON/)
  })
})

describe('PubSub：订阅与投递', () => {
  it('精确频道：收到其他实例的消息，meta 带频道与来源', async () => {
    const pubsub = makePubSub()
    const seen: Array<{ payload: unknown; meta: unknown }> = []
    pubsub.subscribe('events:user.changed', (payload, meta) => void seen.push({ payload, meta }))
    await pubsub.connect()
    const { sub } = clients()

    sub.emit(
      'message',
      'events:user.changed',
      JSON.stringify({
        instanceId: 'other',
        channel: 'events:user.changed',
        payload: { id: 'u1' },
        publishedAt: 123,
      }),
    )
    expect(seen).toEqual([
      {
        payload: { id: 'u1' },
        meta: { channel: 'events:user.changed', instanceId: 'other', publishedAt: 123 },
      },
    ])
  })

  it('自回环过滤：本实例 id 的消息丢弃', async () => {
    const pubsub = makePubSub()
    const handler = vi.fn()
    pubsub.subscribe('events:user.changed', handler)
    await pubsub.connect()
    const { sub } = clients()

    sub.emit(
      'message',
      'events:user.changed',
      JSON.stringify({
        instanceId: pubsub.id,
        channel: 'events:user.changed',
        payload: {},
        publishedAt: 1,
      }),
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('模式订阅：pmessage 按 pattern 分发，channel 来自实际频道', async () => {
    const pubsub = makePubSub()
    const seen: string[] = []
    pubsub.subscribePattern('stream:*', (_payload, meta) => void seen.push(meta.channel))
    await pubsub.connect()
    const { sub } = clients()

    sub.emit(
      'pmessage',
      'stream:*',
      'stream:task:42',
      JSON.stringify({
        instanceId: 'other',
        channel: 'stream:task:42',
        payload: { event: 'done' },
        publishedAt: 1,
      }),
    )
    expect(seen).toEqual(['stream:task:42'])
  })

  it('坏 JSON / 频道不一致都丢弃且不抛错', async () => {
    const pubsub = makePubSub()
    const handler = vi.fn()
    pubsub.subscribe('events:x', handler)
    await pubsub.connect()
    const { sub } = clients()

    expect(() => sub.emit('message', 'events:x', '{oops')).not.toThrow()
    sub.emit(
      'message',
      'events:x',
      JSON.stringify({ instanceId: 'o', channel: 'events:y', payload: 1, publishedAt: 1 }),
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('一个处理函数抛错不影响其他订阅者', async () => {
    const pubsub = makePubSub()
    const ok = vi.fn()
    pubsub.subscribe('events:x', () => {
      throw new Error('boom')
    })
    pubsub.subscribe('events:x', ok)
    await pubsub.connect()
    const { sub } = clients()

    sub.emit(
      'message',
      'events:x',
      JSON.stringify({ instanceId: 'o', channel: 'events:x', payload: 1, publishedAt: 1 }),
    )
    expect(ok).toHaveBeenCalledTimes(1)
  })
})

describe('PubSub：订阅生命周期', () => {
  it('第一个订阅者建立订阅，最后一个移除时退订', async () => {
    const pubsub = makePubSub()
    const first = pubsub.subscribe('events:x', () => undefined)
    const second = pubsub.subscribe('events:x', () => undefined)
    await pubsub.connect()
    const { sub } = clients()
    expect(sub.subscribed.has('events:x')).toBe(true)

    first()
    await Promise.resolve()
    expect(sub.subscribed.has('events:x')).toBe(true)

    second()
    await Promise.resolve()
    expect(sub.subscribed.has('events:x')).toBe(false)
    expect(sub.unsubscribed).toContain('events:x')
  })

  it('模式订阅同样在最后一个移除时 punsubscribe', async () => {
    const pubsub = makePubSub()
    const off = pubsub.subscribePattern('stream:*', () => undefined)
    await pubsub.connect()
    const { sub } = clients()
    expect(sub.psubscribed.has('stream:*')).toBe(true)

    off()
    await Promise.resolve()
    expect(sub.psubscribed.has('stream:*')).toBe(false)
    expect(sub.punsubscribed).toContain('stream:*')
  })

  it('重连（ready）后重新订阅当前频道与模式', async () => {
    const pubsub = makePubSub()
    pubsub.subscribe('events:x', () => undefined)
    pubsub.subscribePattern('stream:*', () => undefined)
    await pubsub.connect()
    const { sub } = clients()
    sub.subscribed.clear()
    sub.psubscribed.clear()

    sub.emit('ready')
    await Promise.resolve()
    await Promise.resolve()
    expect(sub.subscribed.has('events:x')).toBe(true)
    expect(sub.psubscribed.has('stream:*')).toBe(true)
  })

  it('非法频道直接抛', async () => {
    const pubsub = makePubSub()
    expect(() => pubsub.subscribe('', () => undefined)).toThrowError(/非法的 Pub\/Sub 频道/)
    expect(() => pubsub.subscribe('a b', () => undefined)).toThrowError(/非法的 Pub\/Sub 频道/)
    await expect(pubsub.broadcast('x'.repeat(300), {})).rejects.toThrowError(/非法的 Pub\/Sub 频道/)
  })
})
