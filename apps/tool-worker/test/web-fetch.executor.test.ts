import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppLogger } from '@repo/kits'
import type { ToolInvokeRequest } from '@repo/contracts'
import { WebFetchExecutor } from '../src/tools/web/web-fetch.executor.js'
import type { ToolWorkerConfigValue } from '../src/config/app-config.js'

const config: ToolWorkerConfigValue = {
  id: 'w-test',
  version: '0.1.0',
  zone: 'test',
  endpoint: 'http://127.0.0.1:9994',
  internalToken: 'token',
  heartbeatIntervalMs: 10_000,
  staleAfterMs: 30_000,
  maxConcurrency: 2,
  workspaceRoot: '/tmp/billy-tool-worker-test',
  commandTimeoutMs: 15_000,
  maxOutputBytes: 64 * 1024,
  web: {
    timeoutMs: 5_000,
    maxBytes: 1024 * 1024,
    pageLines: 100,
    cacheTtlMs: 60_000,
    allowPrivateNetwork: true,
  },
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger

const request = (input: Record<string, unknown>): ToolInvokeRequest => ({
  version: 1,
  requestId: 'req-web',
  toolKey: 'web-fetch',
  toolCallId: 'call-web',
  input,
  caller: {
    conversationId: 'c-1',
    runId: 'r-1',
    userId: 'u-1',
    isAdmin: false,
    agentKey: 'assistant',
    rootAgentKey: 'assistant',
    depth: 0,
  },
  deadlineMs: 10_000,
})

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<html><head><title>测试页</title></head><body><h1>标题</h1><p>第一行</p><p>第二行</p></body></html>',
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

describe('WebFetchExecutor', () => {
  it('抓取 HTML → Markdown，返回分页与 ref', async () => {
    const executor = new WebFetchExecutor(config, logger)
    const outcome = await executor.execute(request({ url: baseUrl, page: 1 }))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const data = outcome.data as {
      ref: string
      title: string | null
      content: string
      page: { current: number; total: number }
    }
    expect(data.title).toBe('测试页')
    expect(data.ref).toBeTruthy()
    expect(data.content).toContain('第一行')
    expect(data.page.current).toBe(1)
  })

  it('缺 url / ref 返回 invalid-input', async () => {
    const executor = new WebFetchExecutor(config, logger)
    const outcome = await executor.execute(request({ page: 1 }))
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-input' })
  })
})
