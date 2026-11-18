import { describe, expect, it, vi } from 'vitest'
import type { AppLogger } from '@repo/kits'

/** 网关客户端替身：只验证「登记成 draft → 自检 → 切 active/draft」的顺序与入参 */
const gateway = vi.hoisted(() => ({
  registered: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<{ service: string; status: string }>,
  services: [] as unknown[],
  mcpCalls: [] as Array<Record<string, unknown>>,
  mcpTools: [
    {
      key: 'echo-msg',
      remoteTool: 'echo_msg',
      title: '回显',
      description: '回显文本',
      inputSchema: { type: 'object' },
    },
  ] as Array<Record<string, unknown>>,
  mcpFails: false,
}))

vi.mock('@repo/internal-sdk', () => ({
  CapabilityGatewayClient: class {
    async register(registration: Record<string, unknown>): Promise<unknown> {
      gateway.registered.push(registration)
      return {
        accepted: true,
        service: registration.service,
        version: 1,
        added: [],
        changed: [],
        removed: [],
        capabilities: [],
      }
    }

    async setStatus(input: { service: string; status: string }): Promise<{ updated: boolean }> {
      gateway.statuses.push(input)
      return { updated: true }
    }

    async listServices(): Promise<{ services: unknown[] }> {
      return { services: gateway.services }
    }

    async discoverMcp(input: Record<string, unknown>): Promise<unknown> {
      gateway.mcpCalls.push(input)
      if (gateway.mcpFails) throw new Error('握手失败')
      return { protocolVersion: '2025-06-18', tools: gateway.mcpTools }
    }
  },
}))

const { CapabilityServiceAdminService } =
  await import('../src/modules/ai-admin/capability/capability.service.js')

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AppLogger

const serviceRecord = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  service: 'order',
  title: '订单服务',
  owner: 'B 团队',
  source: 'manual',
  protocol: 'capability',
  baseUrl: 'https://orders.example.com',
  healthPath: '/healthz',
  allowHttp: false,
  status: 'active',
  capabilities: [
    {
      tool: 'create',
      title: '下单',
      description: '创建订单',
      inputSchema: { type: 'object' },
      risk: 'read',
      idempotent: false,
      scope: 'all',
      timeoutMs: 30_000,
      pagination: 'none',
      tags: [],
      execution: {
        mode: 'sync',
        owner: 'session',
        yieldMs: 45_000,
        wait: { maxWaitMs: 0 },
        cancel: 'none',
        poll: { minIntervalMs: 1_000 },
        maxRunMs: 1_800_000,
      },
    },
  ],
  deprecated: [],
  instances: {},
  probe: { state: 'unknown', failures: 0, successes: 0, lastProbedAt: 0 },
  version: 1,
  updatedAt: 0,
  auth: { mode: 'gateway-injected', header: 'x-api-key', hasCredential: false },
  ...over,
})

const dto = () => ({
  service: 'order',
  title: '订单服务',
  owner: 'B 团队',
  protocol: 'capability' as const,
  baseUrl: 'https://orders.example.com',
  healthPath: '/healthz',
  allowHttp: false,
  auth: { mode: 'gateway-injected' as const, header: 'x-api-key' },
  capabilities: [{ tool: 'create', title: '下单', description: '创建订单' }],
})

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('能力服务保存：两项自检 + draft 门槛（协议 §4.3 / §4.5）', () => {
  it('连通 + 冒烟都过 → 先登记 draft，再切 active', async () => {
    gateway.registered.length = 0
    gateway.statuses.length = 0
    gateway.services = [serviceRecord({ status: 'active' })]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).endsWith('/invoke')
          ? jsonResponse({ version: 1, ok: false, reason: 'invalid-input', message: '缺参数' })
          : jsonResponse({ status: 'ok' }),
      ),
    )

    const service = new CapabilityServiceAdminService(logger)
    const saved = await service.save(dto())

    expect(gateway.registered[0]).toMatchObject({
      service: 'order',
      source: 'manual',
      status: 'draft',
    })
    expect(gateway.statuses).toEqual([{ service: 'order', status: 'active' }])
    expect(saved.selfCheck).toEqual({ connected: true, smoke: true })
    expect(saved.status).toBe('active')
  })

  it('连通失败 → 留在 draft，并把原因带回页面', async () => {
    gateway.registered.length = 0
    gateway.statuses.length = 0
    gateway.services = [serviceRecord({ status: 'draft' })]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ message: 'boom' }, 503)),
    )

    const service = new CapabilityServiceAdminService(logger)
    const saved = await service.save(dto())

    expect(gateway.statuses).toEqual([{ service: 'order', status: 'draft' }])
    expect(saved.status).toBe('draft')
    expect(saved.selfCheck).toMatchObject({ connected: false, smoke: false })
    expect(saved.selfCheck?.message).toContain('测试连通失败')
  })

  it('连通过但 /invoke 不说协议 → 也算冒烟失败', async () => {
    gateway.registered.length = 0
    gateway.statuses.length = 0
    gateway.services = [serviceRecord({ status: 'draft' })]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).endsWith('/invoke')
          ? jsonResponse({ hello: 'world' })
          : jsonResponse({ ok: 'up' }),
      ),
    )

    const service = new CapabilityServiceAdminService(logger)
    const saved = await service.save(dto())

    expect(saved.selfCheck).toMatchObject({ connected: true, smoke: false })
    expect(gateway.statuses).toEqual([{ service: 'order', status: 'draft' }])
  })
})

describe('MCP 服务保存：握手 + tools/list 自检', () => {
  it('MCP 自检走 discovery；有工具 → active', async () => {
    gateway.registered.length = 0
    gateway.statuses.length = 0
    gateway.mcpCalls.length = 0
    gateway.services = [serviceRecord({ service: 'mcp-demo', protocol: 'mcp', status: 'active' })]

    const service = new CapabilityServiceAdminService(logger)
    const saved = await service.save({
      service: 'mcp-demo',
      title: 'MCP 示例',
      owner: '测试',
      protocol: 'mcp',
      baseUrl: 'https://mcp.example.com',
      healthPath: '/mcp',
      allowHttp: false,
      auth: { mode: 'gateway-injected', header: 'authorization' },
      capabilities: [
        {
          tool: 'echo-msg',
          remoteTool: 'echo_msg',
          title: '回显',
          description: '回显文本',
        },
      ],
    })

    expect(gateway.mcpCalls[0]).toMatchObject({ url: 'https://mcp.example.com/mcp' })
    expect(gateway.registered[0]).toMatchObject({ protocol: 'mcp', status: 'draft' })
    expect(saved.selfCheck).toEqual({ connected: true, smoke: true })
    expect(gateway.statuses).toEqual([{ service: 'mcp-demo', status: 'active' }])
  })

  it('MCP 握手失败 → 留在 draft 并带原因', async () => {
    gateway.statuses.length = 0
    gateway.mcpFails = true
    gateway.services = [serviceRecord({ service: 'mcp-demo', protocol: 'mcp', status: 'draft' })]

    const service = new CapabilityServiceAdminService(logger)
    const saved = await service.save({
      service: 'mcp-demo',
      title: 'MCP 示例',
      owner: '测试',
      protocol: 'mcp',
      baseUrl: 'https://mcp.example.com',
      healthPath: '/mcp',
      allowHttp: false,
      auth: { mode: 'gateway-injected', header: 'authorization' },
      capabilities: [{ tool: 'echo-msg', title: '回显', description: '回显文本' }],
    })

    gateway.mcpFails = false
    expect(saved.status).toBe('draft')
    expect(saved.selfCheck).toMatchObject({ connected: false, smoke: false })
    expect(saved.selfCheck?.message).toContain('MCP 握手失败')
    expect(gateway.statuses).toEqual([{ service: 'mcp-demo', status: 'draft' }])
  })
})
