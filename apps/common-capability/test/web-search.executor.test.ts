import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppLogger } from '@repo/kits'
import type { ToolInvokeRequest } from '@repo/contracts'
import { WebSearchExecutor } from '../src/tools/web/web-search.executor.js'
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

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger

const request = (over: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest => ({
  version: 1,
  requestId: 'req-search',
  toolKey: 'web-search',
  toolCallId: 'call-search',
  input: { query: 'DeepSeek', count: 2 },
  caller: {
    conversationId: 'c-1',
    runId: 'r-1',
    userId: 'u-1',
    isAdmin: false,
    agentKey: 'assistant',
    rootAgentKey: 'assistant',
    depth: 0,
  },
  settings: {
    config: {},
    limits: {},
    secrets: { apiKey: 'sk-test' },
    version: 'test',
  },
  deadlineMs: 10_000,
  ...over,
})

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url !== '/v1/tools/search') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        results: [
          {
            title: 'DeepSeek',
            url: 'https://example.com/a',
            snippet: '摘要',
            summary: '长摘要',
            site_name: 'example',
            date: '2026-01-01',
            authority: 3,
            rerank_score: 2.1,
          },
        ],
      }),
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

describe('WebSearchExecutor', () => {
  it('用 settings 的密钥与 baseUrl 调搜索接口', async () => {
    const executor = new WebSearchExecutor(config, logger)
    const outcome = await executor.execute(
      request({
        settings: {
          config: { baseUrl, allowPrivateNetwork: true },
          limits: {},
          secrets: { apiKey: 'sk-test' },
          version: 'test',
        },
      }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const data = outcome.data as { returned: number; results: Array<{ title: string }> }
    expect(data.returned).toBe(1)
    expect(data.results[0]?.title).toBe('DeepSeek')
  })

  it('缺密钥返回 precheck-failed', async () => {
    const executor = new WebSearchExecutor(config, logger)
    const outcome = await executor.execute(
      request({ settings: { config: {}, limits: {}, secrets: {}, version: 'test' } }),
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'precheck-failed' })
  })
})
