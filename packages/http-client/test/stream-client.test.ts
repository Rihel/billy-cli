import { describe, expect, it, vi } from 'vitest'
import {
  HttpStreamClient,
  StreamClientState,
  BearerTokenStrategy,
  MemoryCredentialsManager,
} from '../src/index.js'
import type { StreamClientOptions } from '../src/index.js'

/** 构造 SSE 流式响应。 */
const streamResponse = (chunks: string[], status = 200) => {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** 保持打开的流（连接不断，供 close/重连场景）。 */
const openStream = () =>
  new ReadableStream<Uint8Array>({
    start() {
      /* 保持打开 */
    },
  })

const streamOpenResponse = () =>
  new Response(openStream(), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

const makeClient = (overrides: Partial<StreamClientOptions> = {}, token = 'test-token') => {
  const options: StreamClientOptions = {
    url: '/sse/subscribe',
    credentialsManager: new MemoryCredentialsManager({ token }),
    authStrategy: new BearerTokenStrategy(),
    retryInterval: 10,
    ...overrides,
  }
  return new HttpStreamClient(options)
}

describe('HttpStreamClient 连接状态机', () => {
  it('初始状态为 idle，connect 后流转 connecting → open', async () => {
    const fetchMock = vi.fn(async () => streamOpenResponse())
    const sse = makeClient({ fetch: fetchMock as unknown as typeof fetch })

    expect(sse.currentState).toBe(StreamClientState.Idle)
    sse.connect()
    expect(sse.currentState).toBe(StreamClientState.Connecting)
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('close() 进入 closed 终态并中断连接', async () => {
    const fetchMock = vi.fn(async () => streamOpenResponse())
    const sse = makeClient({ fetch: fetchMock as unknown as typeof fetch })
    sse.connect()
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    sse.close()
    expect(sse.currentState).toBe(StreamClientState.Closed)
    // 中断后不再重连
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('重复 connect 抛错（非 idle/closed 状态）', async () => {
    const fetchMock = vi.fn(async () => streamOpenResponse())
    const sse = makeClient({ fetch: fetchMock as unknown as typeof fetch })
    sse.connect()
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    expect(() => sse.connect()).toThrow(/不能发起连接/)
  })

  it('服务端正常关闭流 → closed 终态（不自动重连）', async () => {
    const fetchMock = vi.fn(async () => streamResponse(['event: a\ndata: 1\n\n']))
    const sse = makeClient({ fetch: fetchMock as unknown as typeof fetch })
    sse.connect()
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Closed))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('网络失败 → reconnecting → 重连成功 → open', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementation(async () => streamOpenResponse())
    const sse = makeClient({ fetch: fetchMock as unknown as typeof fetch })
    const states: string[] = []
    sse.on('reconnecting', () => states.push(sse.currentState))

    sse.connect()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    expect(states).toContain(StreamClientState.Reconnecting)
  })

  it('服务端宣告排空（stream.shutdown）→ 重连而不是进入终态（滚动更新场景）', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () =>
        streamResponse(['event: stream.shutdown\ndata: {"reason":"server-shutdown"}\n\n']),
      )
      .mockImplementation(async () => streamOpenResponse())
    const sse = makeClient({ fetch: fetchMock as unknown as typeof fetch })

    sse.connect()
    // 未订阅 stream.shutdown 也要生效：重连语义不能依赖业务侧注册了监听器
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    sse.close()
  })
})

describe('HttpStreamClient 事件分发', () => {
  it('按事件名分发（data 为 JSON 反序列化结果）', async () => {
    const fetchMock = vi.fn(async () =>
      streamResponse([
        'event: progress\ndata: {"percent":50}\n\n',
        'event: done\ndata: {"ok":true}\n\n',
      ]),
    )
    const sse = makeClient({ fetch: fetchMock as unknown as typeof fetch })
    const progress: unknown[] = []
    const done: unknown[] = []
    sse.on('progress', (data) => progress.push(data))
    sse.on('done', (data) => done.push(data))
    sse.connect()
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Closed))
    expect(progress).toEqual([{ percent: 50 }])
    expect(done).toEqual([{ ok: true }])
  })

  it('非 JSON data 原样分发原始字符串', async () => {
    const fetchMock = vi.fn(async () => streamResponse(['event: raw\ndata: plain-text\n\n']))
    const sse = makeClient({ fetch: fetchMock as unknown as typeof fetch })
    const received: unknown[] = []
    sse.on('raw', (data) => received.push(data))
    sse.connect()
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0]).toBe('plain-text')
  })

  it('on() 返回的取消函数可退订', async () => {
    const fetchMock = vi.fn(async () =>
      streamResponse(['event: e\ndata: 1\n\n', 'event: e\ndata: 2\n\n']),
    )
    const sse = makeClient({ fetch: fetchMock as unknown as typeof fetch })
    const received: unknown[] = []
    const off = sse.on('e', (data) => received.push(data))
    off()
    sse.connect()
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Closed))
    expect(received).toHaveLength(0)
  })

  it('状态事件 open / closed 可订阅', async () => {
    const fetchMock = vi.fn(async () => streamResponse([]))
    const sse = makeClient({ fetch: fetchMock as unknown as typeof fetch })
    const openSpy = vi.fn()
    const closedSpy = vi.fn()
    sse.on('open', openSpy)
    sse.on('closed', closedSpy)
    sse.connect()
    await vi.waitFor(() => expect(openSpy).toHaveBeenCalled())
    await vi.waitFor(() => expect(closedSpy).toHaveBeenCalled())
  })
})

describe('HttpStreamClient 请求配置', () => {
  it('默认 POST，body 为 { channels }', async () => {
    const fetchMock = vi.fn(async () => streamOpenResponse())
    const sse = makeClient({
      channels: ['task:42', 'user:1'],
      fetch: fetchMock as unknown as typeof fetch,
    })
    sse.connect()
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ channels: ['task:42', 'user:1'] }))
  })

  it('可配置 GET 方法（不发送 body，也不带 Content-Type）', async () => {
    const fetchMock = vi.fn(async () => streamOpenResponse())
    const sse = makeClient({
      method: 'GET',
      channels: ['task:42'],
      fetch: fetchMock as unknown as typeof fetch,
    })
    sse.connect()
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    // 无 body 就不该带 Content-Type
    expect(init.headers).not.toHaveProperty('Content-Type')
  })

  it('自定义 body 覆盖 channels 默认序列化', async () => {
    const fetchMock = vi.fn(async () => streamOpenResponse())
    const sse = makeClient({
      body: { topic: 'custom' },
      fetch: fetchMock as unknown as typeof fetch,
    })
    sse.connect()
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBe(JSON.stringify({ topic: 'custom' }))
  })

  it('有 body 时自动补 Content-Type: application/json（服务端 body parser 才解析）', async () => {
    const fetchMock = vi.fn(async () => streamOpenResponse())
    const sse = makeClient({
      channels: ['task:42'],
      fetch: fetchMock as unknown as typeof fetch,
    })
    sse.connect()
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
  })

  it('body 为 null 时视为显式无请求体：不发 body、不带 Content-Type', async () => {
    const fetchMock = vi.fn(async () => streamOpenResponse())
    const sse = makeClient({
      body: null,
      channels: ['task:42'],
      fetch: fetchMock as unknown as typeof fetch,
    })
    sse.connect()
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // 回归：旧实现会 JSON.stringify(null) 把字面量 "null" 当 body 发出去
    expect(init.body).toBeUndefined()
    expect(init.headers).not.toHaveProperty('Content-Type')
  })

  it('调用方显式设置的 Content-Type 不被覆盖（大小写不敏感）', async () => {
    const fetchMock = vi.fn(async () => streamOpenResponse())
    const sse = makeClient({
      channels: ['task:42'],
      headers: { 'content-type': 'application/json; charset=utf-8' },
      fetch: fetchMock as unknown as typeof fetch,
    })
    sse.connect()
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json; charset=utf-8')
    expect(headers).not.toHaveProperty('Content-Type')
  })
})

describe('HttpStreamClient 认证', () => {
  it('经 authStrategy 注入 Authorization header', async () => {
    const fetchMock = vi.fn(async () => streamOpenResponse())
    const sse = makeClient({ fetch: fetchMock as unknown as typeof fetch })
    sse.connect()
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' })
  })

  it('重连前重新解析凭证（manager 更新后使用新 token）', async () => {
    const manager = new MemoryCredentialsManager({ token: 'v1' })
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementation(async () => streamOpenResponse())
    const sse = new HttpStreamClient({
      url: '/sse/subscribe',
      credentialsManager: manager,
      authStrategy: new BearerTokenStrategy(),
      retryInterval: 100,
      fetch: fetchMock as unknown as typeof fetch,
    })
    sse.connect()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // 第一次失败后、重连前更新凭证
    await manager.setCredentials({ token: 'v2' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    const first = fetchMock.mock.calls[0] as [string, RequestInit]
    const second = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(first[1].headers).toMatchObject({ Authorization: 'Bearer v1' })
    expect(second[1].headers).toMatchObject({ Authorization: 'Bearer v2' })
  })

  it('凭证可刷新：provider.acquire 在无凭证时提供新凭证', async () => {
    const manager = new MemoryCredentialsManager({})
    const acquire = vi.fn(async () => ({ token: 'acquired-token' }))
    const provider = {
      acquire,
      needsRefresh: (credentials: { token?: string }) => !credentials?.token,
    }
    const fetchMock = vi.fn(async () => streamOpenResponse())
    const sse = new HttpStreamClient({
      url: '/sse/subscribe',
      credentialsManager: manager,
      authStrategy: new BearerTokenStrategy(),
      credentialProvider: provider,
      fetch: fetchMock as unknown as typeof fetch,
    })
    sse.connect()
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: 'Bearer acquired-token' })
  })
})

describe('HttpStreamClient 页面隐藏 / 恢复（openWhenHidden）', () => {
  /** 最小 document 替身：node 环境没有 document，只为覆盖 visibilitychange 分支 */
  const installDocumentStub = () => {
    const listeners = new Set<() => void>()
    const doc = {
      hidden: false,
      addEventListener: (_type: string, handler: () => void) => {
        listeners.add(handler)
      },
      removeEventListener: (_type: string, handler: () => void) => {
        listeners.delete(handler)
      },
    }
    const host = globalThis as { document?: unknown }
    host.document = doc
    const emit = () => listeners.forEach((handler) => handler())
    return {
      hide: () => {
        doc.hidden = true
        emit()
      },
      show: () => {
        doc.hidden = false
        emit()
      },
      cleanup: () => {
        delete host.document
      },
    }
  }

  /**
   * 模拟真实 fetch 的 abort 语义：
   * - signal 已 aborted → 立刻抛 AbortError
   * - 连接中途 abort → 终止 body 流（真实 fetch 会 cancel body；不模拟的话
   *   `reader.read()` 永远挂起，transport 的 closed 永不 settle，重连循环走不下去）
   */
  const signalAwareFetch = () =>
    vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener(
            'abort',
            () => {
              try {
                controller.error(new DOMException('The operation was aborted.', 'AbortError'))
              } catch {
                /* 已终止 */
              }
            },
            { once: true },
          )
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

  it('恢复可见后自动重连（回归：旧实现静默进入 closed 且永不重连）', async () => {
    const doc = installDocumentStub()
    const fetchMock = signalAwareFetch()
    const sse = makeClient({ fetch: fetchMock as unknown as typeof fetch })

    try {
      sse.connect()
      await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
      expect(fetchMock).toHaveBeenCalledTimes(1)

      doc.hide()
      doc.show()

      // 关键：第二次连接必须真的建立（旧实现会带着已 abort 的 signal 重连，
      // 被 transport 当成正常结束 → 直接 closed）
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
      expect(sse.currentState).not.toBe(StreamClientState.Closed)
    } finally {
      sse.close()
      doc.cleanup()
    }
  })

  it('openWhenHidden: true 时隐藏不断开、不重连', async () => {
    const doc = installDocumentStub()
    const fetchMock = signalAwareFetch()
    const sse = makeClient({
      openWhenHidden: true,
      fetch: fetchMock as unknown as typeof fetch,
    })

    try {
      sse.connect()
      await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))

      doc.hide()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(sse.currentState).toBe(StreamClientState.Open)
    } finally {
      sse.close()
      doc.cleanup()
    }
  })
})

describe('HttpStreamClient Last-Event-ID 续传', () => {
  it('收到带 id 的事件后，重连请求携带 Last-Event-ID', async () => {
    // 可控流：先手动推送一条带 id 的消息，随后让流出错（模拟收到消息后网络中断）
    let pushMessage: (chunk: Uint8Array) => void
    let errorStream: (err: Error) => void
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        pushMessage = (chunk) => controller.enqueue(chunk)
        errorStream = (err) => controller.error(err)
      },
    })
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
      )
      .mockImplementation(async () => streamOpenResponse())

    const sse = makeClient({ fetch: fetchMock as unknown as typeof fetch })
    sse.connect()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    // 推送带 id 的消息，稍后让流出错 → 触发重连
    pushMessage!(new TextEncoder().encode('id: 5\nevent: a\ndata: 1\n\n'))
    setTimeout(() => errorStream!(new Error('stream interrupted')), 20)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(sse.currentState).toBe(StreamClientState.Open))
    const second = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(second[1].headers).toMatchObject({ 'Last-Event-ID': '5' })
  })
})
