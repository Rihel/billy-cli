import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolGatewayConfigValue } from '../src/config/app-config.js'
import { CapabilityProbeService } from '../src/registry/capability.probe.js'
import { ServiceRegistry } from '../src/registry/service.registry.js'

const config: ToolGatewayConfigValue = {
  internalToken: 'token',
  staleAfterMs: 30_000,
  invokeTimeoutMs: 2_000,
  rateLimitPerMinute: 60,
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never

describe('CapabilityProbeService：外部服务探活', () => {
  it('连续 3 次失败转 down（能力不消失），连续 2 次成功转 up', async () => {
    let status = 500
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end('{}')
    })
    servers.push(server)
    const baseUrl = await listen(server)

    const registry = new ServiceRegistry(config)
    await registry.register({
      protocolVersion: 1,
      service: 'order',
      title: '订单服务',
      owner: 'B 团队',
      source: 'manual',
      baseUrl,
      allowHttp: true,
      capabilities: [{ tool: 'create', title: '下单', description: '创建订单' }],
    })
    const probe = new CapabilityProbeService(registry, config, logger)
    const service = (await registry.snapshot())[0]!

    await probe.probe(service)
    await probe.probe(service)
    expect((await registry.snapshot())[0]!.probe.state).not.toBe('down')
    await probe.probe(service)
    expect((await registry.snapshot())[0]!.probe.state).toBe('down')

    const catalog = await registry.catalog()
    expect(catalog.find((item) => item.key === 'create')?.available).toBe(false)
    // 能力还在目录里，只是不可用
    expect(catalog.map((item) => item.key)).toContain('create')

    status = 200
    await probe.probe((await registry.snapshot())[0]!)
    await probe.probe((await registry.snapshot())[0]!)
    expect((await registry.snapshot())[0]!.probe.state).toBe('up')
    expect((await registry.catalog())[0]!.available).toBe(true)
  })

  it('连接失败也算一次失败，不抛异常', async () => {
    const registry = new ServiceRegistry(config)
    await registry.register({
      protocolVersion: 1,
      service: 'dead',
      title: '不可达服务',
      owner: 'B 团队',
      source: 'manual',
      baseUrl: 'http://127.0.0.1:1',
      allowHttp: true,
      capabilities: [{ tool: 'ping', title: 'ping', description: 'ping' }],
    })
    const probe = new CapabilityProbeService(registry, config, logger)
    const service = (await registry.snapshot())[0]!
    for (let i = 0; i < 3; i += 1) await probe.probe(service)
    expect((await registry.snapshot())[0]!.probe.state).toBe('down')
  })
})

describe('MCP 服务不参与 HTTP 探活', () => {
  it('probe() 对 protocol=mcp 直接返回，不改探活状态', async () => {
    const registry = new ServiceRegistry(config)
    await registry.register({
      protocolVersion: 1,
      service: 'mcp-demo',
      title: 'MCP 示例',
      owner: '测试',
      source: 'manual',
      protocol: 'mcp',
      baseUrl: 'https://mcp.example.com',
      healthPath: '/mcp?key=x',
      capabilities: [{ tool: 'ping', title: 'ping', description: 'ping' }],
    })
    const probe = new CapabilityProbeService(registry, config, logger)
    const service = (await registry.snapshot())[0]!
    await probe.probe(service)
    expect((await registry.snapshot())[0]!.probe.state).toBe('unknown')
  })
})
