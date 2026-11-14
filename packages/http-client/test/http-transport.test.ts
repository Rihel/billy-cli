import { describe, expect, it } from 'vitest'
import { ApiErrorCodes, HttpTransport } from '../src/index.js'

const encoder = new TextEncoder()

const streamOf = (chunks: string[], close = true): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      if (close) controller.close()
    },
  })

describe('HttpTransport', () => {
  it('requestRaw：非 2xx 不抛，保留 status/body；合并默认头、baseUrl、params', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('upstream boom', { status: 500 })
    }) as unknown as typeof fetch
    const transport = new HttpTransport({
      baseUrl: 'http://gw:9992',
      headers: { 'x-internal-token': 'token' },
      fetchImpl,
    })

    const response = await transport.requestRaw({
      url: '/internal/catalog',
      method: 'POST',
      params: { page: 1 },
      headers: { 'x-billy-run-id': 'run-1' },
      data: { hello: 'world' },
    })

    expect(response.status).toBe(500)
    expect(await response.text()).toBe('upstream boom')
    expect(calls[0].url).toBe('http://gw:9992/internal/catalog?page=1')
    const headers = calls[0].init.headers as Headers
    expect(headers.get('x-internal-token')).toBe('token')
    expect(headers.get('x-billy-run-id')).toBe('run-1')
    expect(headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ hello: 'world' })
  })

  it('requestRaw：网络层失败抛 ApiError（NetworkError）', async () => {
    const transport = new HttpTransport({
      baseUrl: 'http://gw:9992',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
    await expect(transport.requestRaw({ url: '/x' })).rejects.toMatchObject({
      code: ApiErrorCodes.NetworkError,
    })
  })

  it('streamRaw：sse() 逐事件解析（跨 chunk）', async () => {
    const transport = new HttpTransport({
      fetchImpl: (async () =>
        new Response(streamOf(['data: {"a":1}\n', '\ndata: [DONE]\n\n']), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })) as unknown as typeof fetch,
    })
    const stream = await transport.streamRaw({ url: 'http://upstream/v1/chat' })
    const messages = []
    for await (const message of stream.sse()) messages.push(message)
    expect(messages.map((m) => m.data)).toEqual(['{"a":1}', '[DONE]'])
    expect(stream.status).toBe(200)
  })

  it('streamRaw：ndjson() 跨 chunk 粘行并跳过空行', async () => {
    const transport = new HttpTransport({
      fetchImpl: (async () =>
        new Response(streamOf(['{"a":1}\n{"b"', ':2}\n\n', '{"c":3}']), {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        })) as unknown as typeof fetch,
    })
    const stream = await transport.streamRaw({ url: 'http://ollama/api/chat' })
    const rows: Array<Record<string, number>> = []
    for await (const row of stream.ndjson<Record<string, number>>()) rows.push(row)
    expect(rows).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('streamRaw：首字节超时抛 NetworkError', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })) as unknown as typeof fetch
    const transport = new HttpTransport({ fetchImpl })
    await expect(
      transport.streamRaw({ url: 'http://upstream/v1/chat' }, { firstByteMs: 10 }),
    ).rejects.toMatchObject({ code: ApiErrorCodes.NetworkError, message: '请求超时' })
  })

  it('streamRaw：空闲超时中断读取', async () => {
    const transport = new HttpTransport({
      fetchImpl: (async () =>
        new Response(streamOf(['{"a":1}\n'], false), {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        })) as unknown as typeof fetch,
    })
    const stream = await transport.streamRaw({ url: 'http://ollama/api/chat' }, { idleMs: 20 })
    await expect(
      (async () => {
        for await (const _row of stream.ndjson()) {
          // 消费首行后卡住，等空闲超时
        }
      })(),
    ).rejects.toMatchObject({ message: '上游空闲超时' })
  })

  it('streamRaw：abort 中断上游', async () => {
    let aborted = false
    const transport = new HttpTransport({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true
        })
        return new Response(streamOf(['{"a":1}\n'], false), {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        })
      }) as unknown as typeof fetch,
    })
    const stream = await transport.streamRaw({ url: 'http://ollama/api/chat' })
    stream.abort('客户端断开')
    expect(aborted).toBe(true)
  })
})
