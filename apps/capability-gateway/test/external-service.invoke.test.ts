import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { CapabilityInvokeRequest } from '@repo/contracts'
import type { ToolGatewayConfigValue } from '../src/config/app-config.js'
import { ServiceInvoker } from '../src/registry/service.invoker.js'
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

const caller: CapabilityInvokeRequest['caller'] = {
  conversationId: 'c-1',
  runId: 'run-1',
  userId: 'u-1',
  isAdmin: false,
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
  depth: 0,
}

const request = (over: Partial<CapabilityInvokeRequest> = {}): CapabilityInvokeRequest => ({
  capability: 'create',
  input: { sku: 'A-1', count: 2 },
  reason: '用户要下单',
  caller,
  deadlineMs: 1_000,
  ...over,
})

/** 注册一个「B 团队那种」外部服务：实现 POST /invoke，约 30 行 */
const registerExternal = async (registry: ServiceRegistry, baseUrl: string): Promise<void> => {
  await registry.register({
    protocolVersion: 1,
    service: 'order',
    title: '订单服务',
    owner: 'B 团队',
    source: 'manual',
    baseUrl,
    allowHttp: true,
    capabilities: [
      {
        tool: 'create',
        title: '下单',
        description: '创建订单',
        inputSchema: {
          type: 'object',
          properties: { sku: { type: 'string' }, count: { type: 'number' } },
          required: ['sku'],
        },
        risk: 'write',
      },
    ],
  })
}

describe('外部服务接入（协议 §4.3 / §7）', () => {
  it('登记一个外部 API，网关按规范 key 找到它、拆成 tool 再调用', async () => {
    let received: Record<string, unknown> | null = null
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        expect(req.method).toBe('POST')
        expect(req.url).toBe('/invoke')
        expect(req.headers['x-capability-key']).toBe('create')
        // 外部服务不拿网关的内部令牌
        expect(req.headers['x-internal-token']).toBeUndefined()
        received = JSON.parse(body) as Record<string, unknown>
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ version: 1, ok: true, data: { orderId: 'order-8891' } }))
      })
    })
    servers.push(server)
    const baseUrl = await listen(server)

    const registry = new ServiceRegistry(config)
    await registerExternal(registry, baseUrl)

    const result = await new ServiceInvoker(registry, config).invoke(request())

    expect(result.outcome).toMatchObject({ ok: true, data: { orderId: 'order-8891' } })
    expect(result.service).toBe('order')
    expect(result.instanceId).toBe('external')
    // 服务只收到工具名（不是规范 key），reason 在顶层，input 原样
    expect(received).toMatchObject({
      version: 1,
      tool: 'create',
      input: { sku: 'A-1', count: 2 },
      reason: '用户要下单',
      deadlineMs: 1_000,
    })
    expect(received).not.toHaveProperty('toolKey')
  })

  it('服务返回业务失败时，网关翻成可解释结论，不抛异常', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          version: 1,
          ok: false,
          reason: 'sku-unavailable',
          message: '库存不足',
          retryable: false,
        }),
      )
    })
    servers.push(server)
    const baseUrl = await listen(server)

    const registry = new ServiceRegistry(config)
    await registerExternal(registry, baseUrl)
    const result = await new ServiceInvoker(registry, config).invoke(request())

    expect(result.outcome).toMatchObject({
      ok: false,
      reason: 'sku-unavailable',
      message: '库存不足',
      retryable: false,
    })
  })

  it('服务返回非契约体时按协议错误处理', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ hello: 'world' }))
    })
    servers.push(server)
    const baseUrl = await listen(server)

    const registry = new ServiceRegistry(config)
    await registerExternal(registry, baseUrl)
    const result = await new ServiceInvoker(registry, config).invoke(request())

    expect(result.outcome).toMatchObject({ ok: false, reason: 'service-protocol-error' })
  })

  it('没登记过的能力返回 no-provider，不臆造端点', async () => {
    const registry = new ServiceRegistry(config)
    const result = await new ServiceInvoker(registry, config).invoke(
      request({ capability: 'cancel' }),
    )
    expect(result.outcome).toMatchObject({ ok: false, reason: 'no-provider' })
  })

  it('外部服务带自己的凭据 header，不透传网关内部令牌', async () => {
    let seen: Record<string, string | string[] | undefined> = {}
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        seen = req.headers
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ version: 1, ok: true, data: { orderId: 'o-1' } }))
      })
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
      auth: { mode: 'gateway-injected', header: 'x-api-key', credential: 'secret-1' },
      capabilities: [{ tool: 'create', title: '下单', description: '创建订单' }],
    })

    const result = await new ServiceInvoker(registry, config).invoke(request())
    expect(result.outcome.ok).toBe(true)
    expect(seen['x-api-key']).toBe('secret-1')
    expect(seen['x-internal-token']).toBeUndefined()
  })

  it('内部服务仍用网关内部令牌', async () => {
    let token: string | string[] | undefined
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        token = req.headers['x-internal-token']
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ version: 1, ok: true, data: {} }))
      })
    })
    servers.push(server)
    const baseUrl = await listen(server)

    const registry = new ServiceRegistry(config)
    await registry.register({
      protocolVersion: 1,
      service: 'exec',
      title: '通用能力',
      owner: '平台组',
      source: 'code',
      instance: { instanceId: 'cc-1', endpoint: baseUrl, maxConcurrency: 8 },
      capabilities: [{ tool: 'bash', title: '执行', description: '跑命令' }],
    })

    const result = await new ServiceInvoker(registry, config).invoke(
      request({ capability: 'bash', input: { command: 'echo hi' } }),
    )
    expect(result.outcome.ok).toBe(true)
    expect(token).toBe('token')
  })

  it('裸名 bash 也能调通：网关解析成 exec/bash 再按 tool=bash 转发', async () => {
    let received: Record<string, unknown> | null = null
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        received = JSON.parse(body) as Record<string, unknown>
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ version: 1, ok: true, data: { stdout: 'hi' } }))
      })
    })
    servers.push(server)
    const baseUrl = await listen(server)

    const registry = new ServiceRegistry(config)
    await registry.register({
      protocolVersion: 1,
      service: 'exec',
      title: '通用能力',
      owner: '平台组',
      source: 'code',
      instance: { instanceId: 'cc-1', endpoint: baseUrl, maxConcurrency: 8 },
      capabilities: [{ tool: 'bash', title: '执行命令', description: '跑命令' }],
    })

    const result = await new ServiceInvoker(registry, config).invoke(
      request({ capability: 'bash', input: { command: 'echo hi' } }),
    )
    expect(result.outcome).toMatchObject({ ok: true, data: { stdout: 'hi' } })
    expect(result.capability).toBe('bash')
    expect(received).toMatchObject({ tool: 'bash', input: { command: 'echo hi' } })
  })
})
