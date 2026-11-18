import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppLogger } from '@repo/kits'
import {
  GatewayToolCatalog,
  applyCatalogToToolFace,
} from '../src/modules/ai/runtime/gateway-capability-catalog.js'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger
const caller = { isAdmin: false, rootAgentKey: 'assistant' }

afterEach(() => {
  delete process.env.TOOL_GATEWAY_URL
  delete process.env.TOOL_GATEWAY_TOKEN
  vi.unstubAllGlobals()
})

describe('GatewayToolCatalog', () => {
  it('从 /v1/capabilities/list 取 key，并按 caller 缓存', async () => {
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
                {
                  key: 'bash',
                  name: 'bash',
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
                {
                  key: 'file-list',
                  name: 'file-list',
                  service: 'files',
                  tool: 'file-list',
                  title: '列文件',
                  description: '列文件',
                  inputSchema: { type: 'object' },
                  risk: 'read',
                  scope: 'all',
                  available: true,
                  tags: [],
                },
              ],
            },
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

describe('applyCatalogToToolFace（授权按执行分流）', () => {
  const local = ['plan-create', 'wait-sub-agent', 'bash', 'web-fetch']

  it('网关目录缺本地工具时，本地工具仍然出现', () => {
    // 目录只认识 worker 工具（bash / web-fetch）：本地工具不能被连坐
    const allowed = applyCatalogToToolFace(local, new Set(['bash', 'web-fetch']))
    expect(allowed).toEqual(['plan-create', 'wait-sub-agent', 'bash', 'web-fetch'])
  })

  it('网关目录缺网关工具时，该工具被剔除', () => {
    const allowed = applyCatalogToToolFace(local, new Set(['bash']))
    expect(allowed).toEqual(['plan-create', 'wait-sub-agent', 'bash'])
    expect(allowed).not.toContain('web-fetch')
  })

  it('本地工具即使不在目录里也不受影响（wait-sub-agent 回归）', () => {
    const allowed = applyCatalogToToolFace(['wait-sub-agent'], new Set(['bash']))
    expect(allowed).toEqual(['wait-sub-agent'])
  })

  it('目录不可用（null）时整份本地工具面放行', () => {
    expect(applyCatalogToToolFace(local, null)).toEqual(local)
  })
})
