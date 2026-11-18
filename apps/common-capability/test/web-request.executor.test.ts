import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppLogger } from '@repo/kits'
import type { ToolInvokeRequest } from '@repo/contracts'
import { WebRequestExecutor } from '../src/tools/web/web-request.executor.js'
import type { ToolWorkerConfigValue } from '../src/config/app-config.js'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger
let server: Server
let config: ToolWorkerConfigValue
let baseUrl: string

const request = (input: Record<string, unknown>): ToolInvokeRequest => ({
  version: 1,
  requestId: 'req-req',
  toolKey: 'web-request',
  toolCallId: 'call-req',
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

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ method: req.method, body: body ? JSON.parse(body) : null }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  baseUrl = `http://127.0.0.1:${address.port}`
  config = {
    id: 'w-test',
    version: '0.1.0',
    zone: 'test',
    endpoint: 'http://127.0.0.1:9994',
    internalToken: 'token',
    heartbeatIntervalMs: 10_000,
    staleAfterMs: 30_000,
    maxConcurrency: 2,
    workspaceRoot: '/tmp/billy-common-capability-test',
    commandTimeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
    web: {
      timeoutMs: 5_000,
      maxBytes: 1024 * 1024,
      pageLines: 1000,
      cacheTtlMs: 60_000,
      allowPrivateNetwork: true,
    },
  }
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

describe('WebRequestExecutor', () => {
  it('POST JSON 并返回展开后的响应体', async () => {
    const executor = new WebRequestExecutor(config, logger)
    const outcome = await executor.execute(
      request({ url: baseUrl, method: 'POST', body: { hello: 'world' } }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const data = outcome.data as { content: string }
    expect(data.content).toContain('"method": "POST"')
    expect(data.content).toContain('"hello": "world"')
  })

  it('GET 带 body 返回 invalid-input', async () => {
    const executor = new WebRequestExecutor(config, logger)
    const outcome = await executor.execute(request({ url: baseUrl, method: 'GET', body: 'x' }))
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-input' })
  })
})
