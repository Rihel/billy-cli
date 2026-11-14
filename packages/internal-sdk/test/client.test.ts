import { describe, expect, it, vi } from 'vitest'
import { TOOL_CONTRACT_VERSION, type ToolInvokeRequest } from '@repo/contracts'
import {
  InternalApiError,
  InternalProtocolError,
  InternalTimeoutError,
  ToolGatewayClient,
  ToolWorkerClient,
} from '../src/index.js'

const request: ToolInvokeRequest = {
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
  deadlineMs: 1_000,
}

const okResponse = {
  version: TOOL_CONTRACT_VERSION,
  requestId: 'req-1',
  workerId: 'w-1',
  durationMs: 2,
  outcome: { ok: true, data: { stdout: 'hi' } },
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('ToolGatewayClient', () => {
  it('带令牌调用 /v1/tools/invoke，并校验响应', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okResponse))
    const client = new ToolGatewayClient({
      baseUrl: 'http://gateway:9993/',
      token: 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await client.invokeTool(request)
    expect(result.workerId).toBe('w-1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://gateway:9993/v1/tools/invoke')
    expect((init.headers as Record<string, string>)['x-internal-token']).toBe('token')
    expect(JSON.parse(String(init.body))).toMatchObject({ toolKey: 'bash' })
  })

  it('非 2xx 抛 InternalApiError，响应不符契约抛 InternalProtocolError', async () => {
    const apiClient = new ToolGatewayClient({
      baseUrl: 'http://gateway:9993',
      token: 'token',
      fetchImpl: (async () => jsonResponse({ error: 'nope' }, 500)) as unknown as typeof fetch,
    })
    await expect(apiClient.invokeTool(request)).rejects.toBeInstanceOf(InternalApiError)

    const protocolClient = new ToolGatewayClient({
      baseUrl: 'http://gateway:9993',
      token: 'token',
      fetchImpl: (async () => jsonResponse({ nope: true })) as unknown as typeof fetch,
    })
    await expect(protocolClient.invokeTool(request)).rejects.toBeInstanceOf(InternalProtocolError)
  })

  it('超时映射成 InternalTimeoutError', async () => {
    const client = new ToolGatewayClient({
      baseUrl: 'http://gateway:9993',
      token: 'token',
      fetchImpl: (async () => {
        throw new DOMException('timeout', 'TimeoutError')
      }) as unknown as typeof fetch,
    })
    await expect(client.invokeTool(request)).rejects.toBeInstanceOf(InternalTimeoutError)
  })

  it('listTools 解析工具清单', async () => {
    const client = new ToolGatewayClient({
      baseUrl: 'http://gateway:9993',
      token: 'token',
      fetchImpl: (async () =>
        jsonResponse({
          version: TOOL_CONTRACT_VERSION,
          tools: [
            {
              key: 'bash',
              title: '执行命令',
              description: '在沙箱里执行命令',
              category: 'core',
              scope: 'all',
              executor: 'worker',
              params: { type: 'object' },
              version: 1,
            },
          ],
        })) as unknown as typeof fetch,
    })
    const result = await client.listTools({
      version: TOOL_CONTRACT_VERSION,
      caller: request.caller,
      agentKey: 'assistant',
      depth: 0,
    })
    expect(result.tools[0]?.key).toBe('bash')
  })

  it('listWorkers 解析注册表结构', async () => {
    const client = new ToolGatewayClient({
      baseUrl: 'http://gateway:9993',
      token: 'token',
      fetchImpl: (async () =>
        jsonResponse({
          workers: [
            {
              workerId: 'w-1',
              endpoint: 'http://worker:9994',
              version: '0.1.0',
              zone: 'local',
              executors: ['bash'],
              tools: ['bash'],
              sandboxMode: 'enforce',
              maxConcurrency: 4,
              active: 1,
              draining: false,
              startedAt: new Date().toISOString(),
            },
          ],
        })) as unknown as typeof fetch,
    })
    await expect(client.listWorkers()).resolves.toHaveLength(1)
  })
})

describe('ToolWorkerClient', () => {
  it('调用 /v1/exec 并复用同一套错误映射', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okResponse))
    const client = new ToolWorkerClient({
      baseUrl: 'http://worker:9994',
      token: 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await client.exec(request)
    expect(result.outcome.ok).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://worker:9994/v1/exec')
    expect((init.headers as Record<string, string>)['x-internal-token']).toBe('token')
  })
})
