import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/events/event-bus.js'
import type { PubSub, PubSubHandler } from '../src/pubsub/pubsub.js'

/**
 * 事件总线的**进程内行为**（PubSub 用替身，不连 Redis）。
 *
 * 广播的自回环过滤、重连重订阅属于 PubSub，另有 `pubsub.test.ts` 覆盖；
 * 这里只测 EventBus 自己的约定：本地先送达、topic 前缀、订阅生命周期、处理函数隔离。
 */

class FakePubSub {
  readonly id = 'self-instance'
  readonly handlers = new Map<string, Set<PubSubHandler>>()
  readonly broadcasts: Array<{ channel: string; payload: unknown }> = []
  broadcastResult = true
  connectCalls = 0

  async connect(): Promise<void> {
    this.connectCalls += 1
  }

  async broadcast(channel: string, payload: unknown): Promise<boolean> {
    this.broadcasts.push({ channel, payload })
    return this.broadcastResult
  }

  subscribe(channel: string, handler: PubSubHandler): () => void {
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  /** 模拟其他实例发来一条消息 */
  remote(channel: string, payload: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) {
      void handler(payload, { channel, instanceId: 'other', publishedAt: 1 })
    }
  }
}

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
}

const makeBus = (): { bus: EventBus; pubsub: FakePubSub } => {
  const pubsub = new FakePubSub()
  const bus = new EventBus(pubsub as unknown as PubSub, logger as never)
  return { bus, pubsub }
}

describe('EventBus：发布', () => {
  it('publish 先本地同步送达，再广播到 events:<topic>', async () => {
    const { bus, pubsub } = makeBus()
    const seen: unknown[] = []
    bus.subscribe('user.changed', (payload) => void seen.push(payload))

    const ok = await bus.publish('user.changed', { id: 'u1' })

    expect(ok).toBe(true)
    expect(seen).toEqual([{ id: 'u1' }])
    expect(pubsub.broadcasts).toEqual([{ channel: 'events:user.changed', payload: { id: 'u1' } }])
  })

  it('广播失败时本地仍送达，返回 false，不抛错', async () => {
    const { bus, pubsub } = makeBus()
    pubsub.broadcastResult = false
    const seen: unknown[] = []
    bus.subscribe('cache.invalidated', (payload) => void seen.push(payload))

    await expect(bus.publish('cache.invalidated', { key: 'k' })).resolves.toBe(false)
    expect(seen).toEqual([{ key: 'k' }])
  })

  it('负载不能序列化时直接报错，且不送达本地、不广播', async () => {
    const { bus, pubsub } = makeBus()
    const seen: unknown[] = []
    bus.subscribe('bad.payload', (payload) => void seen.push(payload))
    const circular: Record<string, unknown> = {}
    circular.self = circular

    await expect(bus.publish('bad.payload', circular)).rejects.toThrowError(/无法序列化为 JSON/)
    expect(seen).toEqual([])
    expect(pubsub.broadcasts).toEqual([])
  })
})

describe('EventBus：接收与订阅', () => {
  it('其他实例的事件经 PubSub 送达本地处理函数', async () => {
    const { bus, pubsub } = makeBus()
    const seen: unknown[] = []
    bus.subscribe('user.changed', (payload) => void seen.push(payload))

    pubsub.remote('events:user.changed', { id: 'remote' })

    expect(seen).toEqual([{ id: 'remote' }])
  })

  it('一个处理函数抛错不影响其他订阅者', async () => {
    const { bus } = makeBus()
    const seen: unknown[] = []
    bus.subscribe('user.changed', () => {
      throw new Error('boom')
    })
    bus.subscribe('user.changed', (payload) => void seen.push(payload))

    await expect(bus.publish('user.changed', { id: 'u2' })).resolves.toBe(true)
    expect(seen).toEqual([{ id: 'u2' }])
  })

  it('第一个订阅者建立远端订阅，最后一个移除时释放', () => {
    const { bus, pubsub } = makeBus()
    const first = bus.subscribe('user.changed', () => undefined)
    const second = bus.subscribe('user.changed', () => undefined)
    expect(pubsub.handlers.get('events:user.changed')?.size).toBe(1)

    first()
    expect(pubsub.handlers.get('events:user.changed')?.size).toBe(1)
    second()
    expect(pubsub.handlers.get('events:user.changed')?.size).toBe(0)
  })

  it('非法 topic 直接抛（大小写 / 空 / 带空格 / 通配符）', async () => {
    const { bus } = makeBus()
    expect(() => bus.subscribe('User.Changed', () => undefined)).toThrowError(/非法的事件 topic/)
    expect(() => bus.subscribe('', () => undefined)).toThrowError(/非法的事件 topic/)
    expect(() => bus.subscribe('user changed', () => undefined)).toThrowError(/非法的事件 topic/)
    await expect(bus.publish('user.changed*', {})).rejects.toThrowError(/非法的事件 topic/)
  })
})
