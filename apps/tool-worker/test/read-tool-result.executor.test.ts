import { describe, expect, it, vi } from 'vitest'
import type { AppLogger, Db, RedisStore } from '@repo/kits'
import type { ToolInvokeRequest } from '@repo/contracts'
import { ReadToolResultExecutor } from '../src/tools/read-tool-result.executor.js'
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
    pageLines: 1000,
    cacheTtlMs: 60_000,
    allowPrivateNetwork: true,
  },
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger

const request = (over: Partial<ToolInvokeRequest> = {}): ToolInvokeRequest => ({
  version: 1,
  requestId: 'req-page',
  toolKey: 'read-tool-result',
  toolCallId: 'call-page',
  input: { handle: 'tr:c-1:call-1', page: 1 },
  caller: {
    conversationId: 'c-1',
    runId: 'r-1',
    userId: 'u-1',
    isAdmin: false,
    agentKey: 'assistant',
    rootAgentKey: 'assistant',
    depth: 0,
  },
  settings: { config: {}, limits: { pageBytes: 64 }, secrets: {}, version: 'test' },
  deadlineMs: 10_000,
  ...over,
})

const build = (full: string | null) => {
  const store = new Map<string, string>()
  if (full !== null) store.set('ai:tool-result:c-1:call-1', full)
  const redis = {
    get: async (key: string) => store.get(key) ?? null,
    incr: async () => 1,
    expire: async () => true,
  } as unknown as RedisStore
  const db = { getRepository: () => ({ findOne: async () => null }) } as unknown as Db
  return new ReadToolResultExecutor(redis, db, config, logger)
}

describe('ReadToolResultExecutor（直连 Redis）', () => {
  it('从 Redis 取全文并分页', async () => {
    const executor = build(JSON.stringify({ text: 'x'.repeat(300) }))
    const outcome = await executor.execute(request())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const data = outcome.data as { content: string; page: { totalPages: number } }
    expect(data.page.totalPages).toBeGreaterThan(1)
    expect(data.content.length).toBeGreaterThan(0)
  })

  it('句柄不属于当前会话 → forbidden', async () => {
    const executor = build('{}')
    const outcome = await executor.execute(
      request({ caller: { ...request().caller, conversationId: 'other' } } as never),
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'forbidden' })
  })
})
