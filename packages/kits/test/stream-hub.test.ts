import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedisConfig } from '../src/redis/redis.config.js'
import { IdGeneration } from '../src/foundation/id-generation/id-generation.js'
import { StreamHub } from '../src/stream/stream-hub.js'
import type { StreamConnection } from '../src/stream/stream-connection.js'
import type { StreamEventModel } from '@repo/shared'
import { testLogger } from './helpers/logger.js'

/** mock Redis 实例（pub / sub 各一），测试通过 emit 模拟广播消息。 */
interface MockRedisInstance {
  connect: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
  psubscribe: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => void
}

const { mockRedisInstances } = vi.hoisted(() => ({
  mockRedisInstances: [] as MockRedisInstance[],
}))

vi.mock('ioredis', () => {
  class MockRedis {
    private handlers = new Map<string, (...args: unknown[]) => void>()
    connect = vi.fn(async () => {})
    quit = vi.fn(async () => {})
    publish = vi.fn(async () => 1)
    psubscribe = vi.fn(async () => {})
    constructor() {
      mockRedisInstances.push(this)
    }
    on(event: string, callback: (...args: unknown[]) => void) {
      this.handlers.set(event, callback)
      return this
    }
    emit(event: string, ...args: unknown[]) {
      this.handlers.get(event)?.(...args)
    }
  }
  return { Redis: MockRedis }
})

const createHub = (): StreamHub =>
  new StreamHub(
    { url: 'redis://localhost:6379/0' } as RedisConfig,
    new IdGeneration(),
    testLogger(),
  )

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitClosed = (connection: StreamConnection): Promise<void> =>
  connection.closed.then(() => undefined)

describe('StreamHub', () => {
  beforeEach(() => {
    mockRedisInstances.length = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('onApplicationBootstrap 建立 pub/sub 两条独立连接并订阅广播模式', async () => {
    const hub = createHub()
    await hub.onApplicationBootstrap()
    expect(mockRedisInstances).toHaveLength(2)
    const [pub, sub] = mockRedisInstances
    expect(pub.connect).toHaveBeenCalled()
    expect(sub.connect).toHaveBeenCalled()
    expect(sub.psubscribe).toHaveBeenCalledWith('stream:*')
    await hub.onApplicationShutdown()
  })

  it('publish 本地直推 + Redis 广播（key 带 stream: 前缀，载荷含频道与事件）', async () => {
    const hub = createHub()
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

    const [pub] = mockRedisInstances
    expect(pub.publish).toHaveBeenCalledWith(
      'stream:task:42',
      expect.stringContaining('"channel":"task:42"'),
    )
    expect(pub.publish).toHaveBeenCalledWith(
      'stream:task:42',
      expect.stringContaining('"event":"progress"'),
    )
    await hub.onApplicationShutdown()
  })

  it('其他实例的广播消息路由到本地连接', async () => {
    const hub = createHub()
    await hub.onApplicationBootstrap()
    const writer = vi.fn(async () => {})
    const connection = hub.createConnection({ writer })
    hub.subscribe(connection, 'task:42')

    const [, sub] = mockRedisInstances
    sub.emit(
      'pmessage',
      'stream:*',
      'stream:task:42',
      JSON.stringify({
        instanceId: 'other-instance',
        channel: 'task:42',
        event: { event: 'done', data: 1 },
      }),
    )
    await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(1))
    expect(writer).toHaveBeenCalledWith({
      id: undefined,
      event: 'done',
      data: '1',
    })
    await hub.onApplicationShutdown()
  })

  it('自回环广播被过滤（instanceId 与本实例相同不推送）', async () => {
    const hub = createHub()
    await hub.onApplicationBootstrap()
    const writer = vi.fn(async () => {})
    const connection = hub.createConnection({ writer })
    hub.subscribe(connection, 'task:42')

    const instanceId = (hub as unknown as { instanceId: string }).instanceId
    const [, sub] = mockRedisInstances
    sub.emit(
      'pmessage',
      'stream:*',
      'stream:task:42',
      JSON.stringify({
        instanceId,
        channel: 'task:42',
        event: { event: 'echo', data: null },
      }),
    )
    await sleep(20)
    expect(writer).not.toHaveBeenCalled()
    await hub.onApplicationShutdown()
  })

  it('连接关闭后不再推送（注销幂等）', async () => {
    const hub = createHub()
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
    const hub = createHub()
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
    const hub = createHub()
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
    const hub = createHub()
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
      const hub = createHub()
      await hub.onApplicationBootstrap()
      const writers = [vi.fn(async () => {}), vi.fn(async () => {})]
      const connections = writers.map((writer) =>
        hub.createConnection({ writer }),
      )
      connections.forEach((connection, index) =>
        hub.subscribe(connection, `task:${index}`),
      )

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
      const registry = (hub as unknown as { connections: Map<string, unknown> })
        .connections
      expect(registry.size).toBe(0)

      await hub.onApplicationShutdown()
    })

    it('没有长连接时排空不报错（无 SSE 客户端也不影响关闭）', async () => {
      const hub = createHub()
      await hub.onApplicationBootstrap()
      await expect(hub.beforeApplicationShutdown()).resolves.toBeUndefined()
      await hub.onApplicationShutdown()
    })

    it('排空中到达的新长连接立即关闭（不会重新挂住关闭流程）', async () => {
      const hub = createHub()
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
