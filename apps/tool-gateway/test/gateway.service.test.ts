import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TOOL_CONTRACT_VERSION,
  type ToolInvokeRequest,
  type WorkerRegistration,
} from '@repo/contracts'
import { ToolGatewayService } from '../src/gateway/gateway.service.js'
import type { RedisStore } from '@repo/kits'
import type { ToolGatewayConfigValue } from '../src/config/app-config.js'
import type { WorkerDirectory } from '../src/workers/worker.directory.js'

const config = (over: Partial<ToolGatewayConfigValue> = {}): ToolGatewayConfigValue => ({
  internalToken: 'token',
  staleAfterMs: 30_000,
  invokeTimeoutMs: 1_000,
  rateLimitPerMinute: 60,
  ...over,
})

const redis = {
  getJson: async () => null,
  setJson: async () => undefined,
} as unknown as RedisStore

const worker = (endpoint: string): WorkerRegistration => ({
  workerId: 'w-1',
  endpoint,
  version: '0.1.0',
  zone: 'test',
  executors: ['bash'],
  tools: ['bash'],
  sandboxMode: 'enforce',
  maxConcurrency: 2,
  active: 0,
  draining: false,
  startedAt: new Date(0).toISOString(),
})

const request = (): ToolInvokeRequest => ({
  version: TOOL_CONTRACT_VERSION,
  requestId: 'req-1',
  toolKey: 'bash',
  toolCallId: 'call-1',
  input: { command: 'echo hi' },
  caller: {
    conversationId: 'c-1',
    runId: 'r-1',
    userId: 'u-1',
    agentKey: 'assistant',
    rootAgentKey: 'assistant',
    depth: 0,
  },
  deadlineMs: 500,
})

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return address.port
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

describe('ToolGatewayService', () => {
  it('选 worker 并转发，返回契约响应', async () => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        expect(req.headers['x-internal-token']).toBe('token')
        const parsed = JSON.parse(body) as ToolInvokeRequest
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              version: TOOL_CONTRACT_VERSION,
              requestId: parsed.requestId,
              workerId: 'w-1',
              durationMs: 2,
              outcome: { ok: true, data: { stdout: 'hi' } },
            },
          }),
        )
      })
    })
    servers.push(server)
    const port = await listen(server)

    const directory = {
      pick: async () => worker(`http://127.0.0.1:${port}`),
    } as unknown as WorkerDirectory
    const service = new ToolGatewayService(directory, redis, config())
    const result = await service.invoke(request())

    expect(result.outcome.ok).toBe(true)
    expect(result.workerId).toBe('w-1')
  })

  it('没有 worker 时返回可重试结论，不抛异常', async () => {
    const directory = { pick: async () => null } as unknown as WorkerDirectory
    const service = new ToolGatewayService(directory, redis, config())
    const result = await service.invoke(request())

    expect(result.outcome).toMatchObject({ ok: false, reason: 'no-worker', retryable: true })
  })

  it('worker 超时返回 timeout 结论', async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      }, 200)
    })
    servers.push(server)
    const port = await listen(server)

    const directory = {
      pick: async () => worker(`http://127.0.0.1:${port}`),
    } as unknown as WorkerDirectory
    const service = new ToolGatewayService(directory, redis, config({ invokeTimeoutMs: 30 }))
    const result = await service.invoke(request())

    expect(result.outcome).toMatchObject({ ok: false, reason: 'timeout', retryable: true })
  })
})
