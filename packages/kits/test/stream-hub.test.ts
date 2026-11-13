import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IdGeneration } from '../src/foundation/id-generation/id-generation.js'
import { StreamHub } from '../src/stream/stream-hub.js'
import type { StreamConnection } from '../src/stream/stream-connection.js'
import type { PubSub, PubSubHandler } from '../src/pubsub/pubsub.js'
import type { StreamEventModel } from '@repo/shared'
import { testLogger } from './helpers/logger.js'

/**
 * StreamHub 的连接语义（广播传输用 PubSub 替身，不连 Redis）。
 *
 * PubSub 自己的自回环过滤 / 重连重订阅由 `pubsub.test.ts` 覆盖；
 * 这里只测：连接注册表、本地直推、跨实例消息路由到本地连接、关闭排空。
 */

class FakePubSub {
  readonly id = 'self-instance'
  readonly patternHandlers = new Map<string, Set<PubSubHandler>>()
  readonly broadcasts: Array<{ channel: string; payload: unknown }> = []
  connectCalls = 0

  async connect(): Promise<void> {
    this.connectCalls += 1
  }

  async broadcast(channel: string, payload: unknown): Promise<boolean> {
    this.broadcasts.push({ channel, payload })
    return true
  }

  subscribePattern(pattern: string, handler: PubSubHandler): () => void {
    let set = this.patternHandlers.get(pattern)
    if (!set) {
      set = new Set()
      this.patternHandlers.set(pattern, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  /** 模拟其他实例的广播（频道是带前缀的完整频道） */
  remote(channel: string, payload: unknown): void {
    for (const handler of this.patternHandlers.get('stream:*') ?? []) {
      void handler(payload, { channel, instanceId: 'other', publishedAt: 1 })
    }
  }
}

const createHub = (): { hub: StreamHub; pubsub: FakePubSub } => {
  const pubsub = new FakePubSub()
  const hub = new StreamHub(pubsub as unknown as PubSub, new IdGeneration(), testLogger())
  return { hub, pubsub }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitClosed = (connection: StreamConnection): Promise<void> =>
  connection.closed.then(() => undefined)

describe('StreamHub', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('onApplicationBootstrap 等待 PubSub 连接，并订阅 stream:* 广播模式', async () => {
    const { hub, pubsub } = createHub()
    await hub.onApplicationBootstrap()
    expect(pubsub.connectCalls).toBe(1)
    expect(pubsub.patternHandlers.get('stream:*')?.size).toBe(1)
    await hub.onApplicationShutdown()
  })

  it('publish 本地直推 + 交 PubSub 广播（频道带 stream: 前缀）', async () => {
    const { hub, pubsub } = createHub()
    await hub.onApplicationBootstrap()
    const writer = vi.fn(async () => {})
    const connection = hub.createConnection({ writer })
    hub.subscribe(connection, 'task:42')

    const event: StreamEventModel = { event: 'progress', data: { percent: 50 } }
    hub.publish('task:42', event)
    await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(1))
    expect(writer).toHaveBeenCalledWith({
      id: undefined,
      event: 'progress',
      data: '{"percent":50}',
    })
    expect(pubsub.broadcasts).toEqual([{ channel: 'stream:task:42', payload: event }])
    await hub.onApplicationShutdown()
  })

  it('其他实例的广播消息路由到本地连接', async () => {
    const { hub, pubsub } = createHub()
    await hub.onApplicationBootstrap()
    const writer = vi.fn(async () => {})
    const connection = hub.createConnection({ writer })
    hub.subscribe(connection, 'task:42')

    pubsub.remote('stream:task:42', { event: 'done', data: 1 })
    await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(1))
    expect(writer).toHaveBeenCalledWith({
      id: undefined,
      event: 'done',
      data: '1',
    })
    await hub.onApplicationShutdown()
  })

  it('启动前（started=false）收到广播不推送', async () => {
    const { hub, pubsub } = createHub()
    const writer = vi.fn(async () => {})
    const connection = hub.createConnection({ writer })
    hub.subscribe(connection, 'task:42')

    pubsub.remote('stream:task:42', { event: 'early', data: null })
    await sleep(10)
    expect(writer).not.toHaveBeenCalled()
    await hub.onApplicationShutdown()
  })

  it('连接关闭后不再推送（注销幂等）', async () => {
    const { hub } = createHub()
    await hub.onApplicationBootstrap()
    const writer = vi.fn(async () => {})
    const connection = hub.createConnection({ writer })
    hub.subscribe(connection, 'task:42')

    connection.close()
    connection.close() // 幂等：重复关闭不报错
    hub.publish('task:42', { event: 'late', data: null })
    await sleep(20)
    expect(writer).not.toHaveBeenCalled()
    await hub.onApplicationShutdown()
  })

  it('abort 信号触发连接自动关闭', async () => {
    const { hub } = createHub()
    await hub.onApplicationBootstrap()
    const controller = new AbortController()
    const writer = vi.fn(async () => {})
    const connection = hub.createConnection({
      writer,
      signal: controller.signal,
    })
    const closed = waitClosed(connection)
    controller.abort()
    await expect(closed).resolves.toBeUndefined()
    await hub.onApplicationShutdown()
  })

  it('心跳周期写注释行保活', async () => {
    const { hub } = createHub()
    await hub.onApplicationBootstrap()
    const writer = vi.fn(async () => {})
    const rawWriter = vi.fn(async () => {})
    const connection = hub.createConnection({
      writer,
      rawWriter,
      heartbeatIntervalMs: 20,
    })
    await vi.waitFor(() => expect(rawWriter).toHaveBeenCalled())
    expect(rawWriter).toHaveBeenCalledWith(': ping\n\n')
    connection.close()
    await hub.onApplicationShutdown()
  })

  it('写入失败（连接断开）自动关闭', async () => {
    const { hub } = createHub()
    await hub.onApplicationBootstrap()
    const writer = vi.fn(async () => {
      throw new Error('broken pipe')
    })
    const connection = hub.createConnection({ writer })
    const closed = waitClosed(connection)
    await connection.write({ event: 'x', data: 1 })
    await expect(closed).resolves.toBeUndefined()
    await hub.onApplicationShutdown()
  })

  describe('beforeApplicationShutdown（关闭流程第一步：排空长连接）', () => {
    it('推 stream.shutdown 并关闭全部连接（否则 httpServer.close() 永不返回）', async () => {
      const { hub } = createHub()
      await hub.onApplicationBootstrap()
      const writers = [vi.fn(async () => {}), vi.fn(async () => {})]
      const connections = writers.map((writer) => hub.createConnection({ writer }))
      connections.forEach((connection, index) => hub.subscribe(connection, `task:${index}`))

      await hub.beforeApplicationShutdown()

      for (const [index, connection] of connections.entries()) {
        await expect(waitClosed(connection)).resolves.toBeUndefined()
        // 关闭前先宣告：客户端据此重连到其他实例，而不是把正常结束当终态
        expect(writers[index]).toHaveBeenCalledWith({
          id: undefined,
          event: 'stream.shutdown',
          data: '{"reason":"server-shutdown"}',
        })
      }
      // 注册表已清空
      const registry = (hub as unknown as { connections: Map<string, unknown> }).connections
      expect(registry.size).toBe(0)

      await hub.onApplicationShutdown()
    })

    it('没有长连接时排空不报错（无 SSE 客户端也不影响关闭）', async () => {
      const { hub } = createHub()
      await hub.onApplicationBootstrap()
      await expect(hub.beforeApplicationShutdown()).resolves.toBeUndefined()
      await hub.onApplicationShutdown()
    })

    it('排空中到达的新长连接立即关闭（不会重新挂住关闭流程）', async () => {
      const { hub } = createHub()
      await hub.onApplicationBootstrap()
      await hub.beforeApplicationShutdown()

      const writer = vi.fn(async () => {})
      const connection = hub.createConnection({ writer })

      await expect(waitClosed(connection)).resolves.toBeUndefined()
      expect(writer).not.toHaveBeenCalled()
      await hub.onApplicationShutdown()
    })
  })
})
