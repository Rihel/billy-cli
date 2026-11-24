import { describe, expect, it, vi } from 'vitest'
import { AgentRuntimeClient } from '../src/agent-runtime.js'

/**
 * agent-runtime 内部客户端：对话执行相关的 4 个 JSON 接口 + 原始流入口。
 *
 * 这些用例锁的是**对外契约**（路径 / 方法 / 令牌 / 身份头 / 204 语义），
 * 不是实现细节：改 SDK 内部传输时不希望行为漂移。
 */

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const chatResult = {
  conversationId: 'c-1',
  runId: 'r-1',
  status: 'completed',
  content: '你好',
  stepCount: 1,
  toolCallCount: 0,
  usage: null,
  durationMs: 12,
}

const snapshot = {
  runId: 'r-1',
  messageId: 'm-1',
  rev: 7,
  sinceRev: 3,
  parts: [],
}

const clientOf = (fetchImpl: typeof fetch) =>
  new AgentRuntimeClient({ baseUrl: 'http://rt', token: 'tok', fetchImpl })

describe('AgentRuntimeClient 对话执行接口', () => {
  it('chat 走 POST /internal/agent/chat：脱信封 + 带身份头', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: chatResult }))
    const client = clientOf(fetchImpl as unknown as typeof fetch)

    const result = await client.chat({ message: 'hi' } as never, {
      headers: { 'x-user-id': 'u-1' },
    })

    expect(result).toMatchObject({ runId: 'r-1', content: '你好' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/internal/agent/chat')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('x-internal-token')).toBe('tok')
    expect(headers.get('x-user-id')).toBe('u-1')
  })

  it('stopRun 走 POST /internal/agent/run/stop 并返回停止方式', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, data: { stopped: true, injected: 'broadcast' } }),
    )
    const client = clientOf(fetchImpl as unknown as typeof fetch)

    await expect(client.stopRun({ conversationId: 'c-1' })).resolves.toEqual({
      stopped: true,
      injected: 'broadcast',
    })
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/internal/agent/run/stop')
  })

  it('snapshotCurrentRun：204 归一成 null', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const client = clientOf(fetchImpl as unknown as typeof fetch)

    await expect(client.snapshotCurrentRun('c-1')).resolves.toBeNull()
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/internal/agent/run/snapshot?conversationId=c-1')
  })

  it('snapshotCurrentRun：200 + 空 body 也按 null（上游 Issue 3）', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }))
    const client = clientOf(fetchImpl as unknown as typeof fetch)

    await expect(client.snapshotCurrentRun('c-1')).resolves.toBeNull()
  })

  it('snapshotRun：runId 编码进路径，正常返回快照', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(snapshot))
    const client = clientOf(fetchImpl as unknown as typeof fetch)

    await expect(client.snapshotRun('r/1')).resolves.toMatchObject({ rev: 7 })
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/internal/agent/run/r%2F1/snapshot')
  })

  it('openStream：返回原始流与状态，转发调用方头', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('data: {"type":"RUN_STARTED"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    const client = clientOf(fetchImpl as unknown as typeof fetch)

    const opened = await client.openStream('/internal/agent/chat/stream', {
      method: 'POST',
      body: { message: 'hi' },
      headers: { 'x-main-client-id': 'client-1', 'x-user-id': 'u-1' },
    })

    expect(opened.status).toBe(200)
    expect(opened.body).not.toBeNull()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/internal/agent/chat/stream')
    const headers = new Headers(init.headers)
    expect(headers.get('x-main-client-id')).toBe('client-1')
    expect(headers.get('x-user-id')).toBe('u-1')
    expect(headers.get('x-internal-token')).toBe('tok')
    await opened.body?.cancel()
  })

  it('openStream：上游 204（没有内容）回 body: null 与状态码', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const client = clientOf(fetchImpl as unknown as typeof fetch)

    const opened = await client.openStream('/internal/agent/run/stream')

    expect(opened.status).toBe(204)
    expect(opened.body).toBeNull()
  })
})
