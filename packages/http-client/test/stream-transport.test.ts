import { describe, expect, it, vi } from 'vitest'
import { streamConnectOnce } from '../src/index.js'
import { StreamTransportError } from '../src/index.js'
import type { StreamMessage } from '../src/index.js'

/** 构造 SSE 流式响应（Node 原生 ReadableStream）。 */
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

/** 保持打开的流（供 abort 测试）。 */
const openStream = () =>
  new ReadableStream<Uint8Array>({
    start() {
      /* 不 close，连接保持 */
    },
  })

describe('streamConnectOnce 单次连接', () => {
  it('正常流：onOpen → onMessage → onClose → closed resolve', async () => {
    const fetchMock = vi.fn(async () =>
      streamResponse(['event: a\ndata: 1\n\n', 'event: b\ndata: 2\n\n']),
    )
    const messages: StreamMessage[] = []
    const events: string[] = []
    const controller = new AbortController()

    const conn = streamConnectOnce(
      {
        url: '/sse/subscribe',
        signal: controller.signal,
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
      {
        onOpen: () => events.push('open'),
        onMessage: (m) => messages.push(m),
        onClose: () => events.push('close'),
      },
    )
    await conn.closed

    expect(events).toEqual(['open', 'close'])
    expect(messages).toHaveLength(2)
    expect(messages[1].event).toBe('b')
    // 默认 POST
    expect(fetchMock).toHaveBeenCalledWith(
      '/sse/subscribe',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('method / headers / body 透传给 fetch', async () => {
    const fetchMock = vi.fn(async () => streamResponse([]))
    const controller = new AbortController()
    const conn = streamConnectOnce(
      {
        url: '/sse/subscribe',
        method: 'GET',
        headers: { Authorization: 'Bearer t' },
        signal: controller.signal,
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
      { onMessage: () => {} },
    )
    await conn.closed
    expect(fetchMock).toHaveBeenCalledWith(
      '/sse/subscribe',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer t' },
      }),
    )
  })

  it('非 SSE content-type 抛 StreamTransportError', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('oops', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const controller = new AbortController()
    const conn = streamConnectOnce(
      {
        url: '/sse/subscribe',
        signal: controller.signal,
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
      { onMessage: () => {} },
    )
    await expect(conn.closed).rejects.toBeInstanceOf(StreamTransportError)
  })

  it('HTTP 非 2xx 抛错并携带 status', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('no', { status: 401 }),
    )
    const controller = new AbortController()
    const conn = streamConnectOnce(
      {
        url: '/sse/subscribe',
        signal: controller.signal,
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
      { onMessage: () => {} },
    )
    const error = await conn.closed.catch((err: unknown) => err)
    expect(error).toBeInstanceOf(StreamTransportError)
    expect((error as StreamTransportError).status).toBe(401)
  })

  it('网络错误 reject（非 abort）', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })
    const controller = new AbortController()
    const conn = streamConnectOnce(
      {
        url: '/sse/subscribe',
        signal: controller.signal,
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
      { onMessage: () => {} },
    )
    await expect(conn.closed).rejects.toThrow('network down')
  })

  it('abort 后静默结束（不 reject）', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(openStream(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    const controller = new AbortController()
    const closedEvents: string[] = []
    const conn = streamConnectOnce(
      {
        url: '/sse/subscribe',
        signal: controller.signal,
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
      { onMessage: () => {}, onClose: () => closedEvents.push('close') },
    )
    controller.abort()
    await conn.closed
    expect(closedEvents).toEqual([])
  })
})
