import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppLogger } from '@repo/kits'
import { GatewayToolCatalog } from '../src/modules/ai/runtime/gateway-tool-catalog.js'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger
const caller = { isAdmin: false, rootAgentKey: 'assistant' }

afterEach(() => {
  delete process.env.TOOL_GATEWAY_URL
  delete process.env.TOOL_GATEWAY_TOKEN
  vi.unstubAllGlobals()
})

describe('GatewayToolCatalog', () => {
  it('从 /v1/tools/list 取 key，并按 caller 缓存', async () => {
    process.env.TOOL_GATEWAY_URL = 'http://gateway:9993'
    process.env.TOOL_GATEWAY_TOKEN = 'token'
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            version: 1,
            tools: [
              {
                key: 'bash',
                title: 'bash',
                description: 'bash',
                category: 'core',
                scope: 'all',
                executor: 'worker',
                params: { type: 'object' },
                version: 1,
              },
              {
                key: 'file-list',
                title: 'file-list',
                description: 'file-list',
                category: 'core',
                scope: 'all',
                executor: 'worker',
                params: { type: 'object' },
                version: 1,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const catalog = new GatewayToolCatalog(logger)
    expect(await catalog.allowedKeys(caller)).toEqual(new Set(['bash', 'file-list']))
    expect(await catalog.allowedKeys(caller)).toEqual(new Set(['bash', 'file-list']))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('未配置或网关失败时返回 null（fail-open）', async () => {
    const catalog = new GatewayToolCatalog(logger)
    expect(await catalog.allowedKeys(caller)).toBeNull()

    process.env.TOOL_GATEWAY_URL = 'http://gateway:9993'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('down'))),
    )
    expect(await catalog.allowedKeys(caller)).toBeNull()
  })
})
