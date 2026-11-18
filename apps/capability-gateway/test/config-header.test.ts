import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityInvokeRequest } from '@repo/contracts'
import type { ToolGatewayConfigValue } from '../src/config/app-config.js'
import type { ToolConfigService } from '../src/config/tool.config.service.js'
import { ServiceInvoker } from '../src/registry/service.invoker.js'
import { ServiceRegistry } from '../src/registry/service.registry.js'

const config: ToolGatewayConfigValue = {
  internalToken: 'token',
  staleAfterMs: 30_000,
  invokeTimeoutMs: 2_000,
  rateLimitPerMinute: 60,
  allowPrivateNetwork: true,
}

const caller: CapabilityInvokeRequest['caller'] = {
  conversationId: 'c-1',
  runId: 'run-1',
  userId: 'u-1',
  isAdmin: false,
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
  depth: 0,
}

const registerExternal = async (): Promise<ServiceRegistry> => {
  const registry = new ServiceRegistry(config)
  await registry.register({
    protocolVersion: 1,
    service: 'search',
    title: '搜索服务',
    owner: '测试',
    source: 'manual',
    baseUrl: 'https://search.example.com',
    capabilities: [{ tool: 'web-search', title: '搜索', description: '搜一下' }],
  })
  return registry
}

const stubConfig = (over: Partial<Record<string, unknown>> = {}): ToolConfigService =>
  ({
    effective: async () => ({
      enabled: true,
      scope: null,
      allowedAgents: null,
      config: { baseUrl: 'https://api.example.com' },
      limits: { rateLimitPerMinute: 5 },
      secrets: { apiKey: 'k-1' },
      version: 'v1',
      ...over,
    }),
  }) as unknown as ToolConfigService

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('x-capability-config 下发（ai_tools → 服务）', () => {
  it('把 config / limits / secrets 放进请求头', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: 1, ok: true, data: {} }))
    vi.stubGlobal('fetch', fetchMock)
    const invoker = new ServiceInvoker(await registerExternal(), config, stubConfig())

    await invoker.invoke({ capability: 'web-search', input: {}, caller, deadlineMs: 1_000 })

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(JSON.parse(headers['x-capability-config']!)).toMatchObject({
      config: { baseUrl: 'https://api.example.com' },
      limits: { rateLimitPerMinute: 5 },
      secrets: { apiKey: 'k-1' },
      version: 'v1',
    })
  })

  it('没有配置行 / 全空时不带这个头', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: 1, ok: true, data: {} }))
    vi.stubGlobal('fetch', fetchMock)
    const empty = stubConfig({ config: {}, limits: {}, secrets: {}, version: 'code-default' })
    const invoker = new ServiceInvoker(await registerExternal(), config, empty)

    await invoker.invoke({ capability: 'web-search', input: {}, caller, deadlineMs: 1_000 })

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>)['x-capability-config']).toBeUndefined()
  })

  it('非 ASCII 值退到 b64: 编码', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ version: 1, ok: true, data: {} }))
    vi.stubGlobal('fetch', fetchMock)
    const invoker = new ServiceInvoker(
      await registerExternal(),
      config,
      stubConfig({ config: { note: '中文配置' } }),
    )

    await invoker.invoke({ capability: 'web-search', input: {}, caller, deadlineMs: 1_000 })

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    const header = (init.headers as Record<string, string>)['x-capability-config']!
    expect(header.startsWith('b64:')).toBe(true)
    const decoded = JSON.parse(Buffer.from(header.slice(4), 'base64url').toString('utf8'))
    expect(decoded.config).toEqual({ note: '中文配置' })
  })
})
