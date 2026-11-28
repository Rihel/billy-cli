import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppLogger } from '@repo/kits'
import { GatewayToolCatalog } from '../src/modules/ai/runtime/model/gateway-capability-catalog.js'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger
const caller = { isAdmin: false, userId: null, rootAgentKey: 'assistant', conversationId: 'c-1' }

afterEach(() => {
  delete process.env.TOOL_GATEWAY_URL
  delete process.env.TOOL_GATEWAY_TOKEN
  vi.unstubAllGlobals()
})

const capability = (over: Record<string, unknown>) => ({
  key: 'bash',
  name: 'bash',
  service: 'common',
  source: 'code',
  tool: 'bash',
  title: '执行命令',
  description: '跑命令',
  inputSchema: { type: 'object' },
  risk: 'write',
  scope: 'all',
  available: true,
  tags: [],
  ...over,
})

describe('GatewayToolCatalog', () => {
  it('从 /v1/capabilities/list 取目录，并按 caller 缓存', async () => {
    process.env.TOOL_GATEWAY_URL = 'http://gateway:9993'
    process.env.TOOL_GATEWAY_TOKEN = 'token'
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              version: 1,
              capabilities: [
                capability({ key: 'bash' }),
                capability({
                  key: 'maps-weather',
                  name: 'maps-weather',
                  service: 'amap-mcp',
                  source: 'manual',
                  tool: 'maps-weather',
                  title: '查天气',
                  description: '查天气',
                }),
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const catalog = new GatewayToolCatalog(logger)
    const first = await catalog.capabilities(caller)
    expect(first?.map((item) => `${item.key}:${item.source}`)).toEqual([
      'bash:code',
      'maps-weather:manual',
    ])
    // 第二次走 5s 缓存，不再发请求
    expect(await catalog.capabilities(caller)).toEqual(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('未配置或网关失败时返回 null（fail-open）', async () => {
    const catalog = new GatewayToolCatalog(logger)
    expect(await catalog.capabilities(caller)).toBeNull()

    process.env.TOOL_GATEWAY_URL = 'http://gateway:9993'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('down'))),
    )
    expect(await catalog.capabilities(caller)).toBeNull()
  })
})
