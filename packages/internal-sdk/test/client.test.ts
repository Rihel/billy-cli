import { describe, expect, it, vi } from 'vitest'
import { TOOL_CONTRACT_VERSION, type CapabilityInvokeRequest } from '@repo/contracts'
import { CapabilityGatewayClient, InternalApiError } from '../src/index.js'

const envelope = (data: unknown) => ({ code: 0, data })

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const caller: CapabilityInvokeRequest['caller'] = {
  conversationId: 'c-1',
  runId: 'r-1',
  userId: 'u-1',
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
  depth: 0,
}

const invokeResult = {
  version: TOOL_CONTRACT_VERSION,
  requestId: 'req-1',
  capability: 'exec/bash',
  service: 'exec',
  instanceId: 'cc-1',
  durationMs: 3,
  outcome: { ok: true, data: { stdout: 'hi' } },
}

describe('CapabilityGatewayClient', () => {
  it('invoke 走 POST /v1/capabilities/invoke，带令牌并脱信封', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(envelope(invokeResult)))
    const client = new CapabilityGatewayClient({ baseUrl: 'http://gw', token: 'tok', fetchImpl })

    const result = await client.invoke({
      capability: 'exec/bash',
      input: { command: 'echo hi' },
      caller,
      deadlineMs: 1_000,
    })

    expect(result.outcome).toMatchObject({ ok: true, data: { stdout: 'hi' } })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/v1/capabilities/invoke')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('x-internal-token')).toBe('tok')
  })

  it('listCapabilities 把规范 key 原样返回', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        envelope({
          version: 1,
          capabilities: [
            {
              key: 'exec/bash',
              name: 'exec__bash',
              service: 'exec',
              tool: 'bash',
              title: '执行命令',
              description: '跑命令',
              inputSchema: { type: 'object' },
              risk: 'write',
              scope: 'all',
              available: true,
              tags: [],
            },
          ],
        }),
      ),
    )
    const client = new CapabilityGatewayClient({ baseUrl: 'http://gw', token: 't', fetchImpl })
    const result = await client.listCapabilities({
      caller: { ...caller, conversationId: 'catalog', runId: 'catalog' },
      agentKey: 'assistant',
      depth: 0,
    })
    expect(result.capabilities[0]?.key).toBe('exec/bash')
  })

  it('非 2xx 归为 InternalApiError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'boom' }, 500))
    const client = new CapabilityGatewayClient({ baseUrl: 'http://gw', token: 't', fetchImpl })
    await expect(
      client.invoke({ capability: 'exec/bash', input: {}, caller, deadlineMs: 100 }),
    ).rejects.toBeInstanceOf(InternalApiError)
  })
})
