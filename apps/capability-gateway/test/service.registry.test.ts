import { describe, expect, it } from 'vitest'
import type { ToolGatewayConfigValue } from '../src/config/app-config.js'
import { ServiceRegistry } from '../src/registry/service.registry.js'

const config: ToolGatewayConfigValue = {
  internalToken: 'token',
  staleAfterMs: 30_000,
  invokeTimeoutMs: 1_000,
  rateLimitPerMinute: 60,
}

const internal = (over: Record<string, unknown> = {}) => ({
  protocolVersion: 1 as const,
  service: 'exec',
  title: '通用能力',
  owner: '平台组',
  source: 'code' as const,
  instance: { instanceId: 'cc-1', endpoint: 'http://10.0.0.1:9994', maxConcurrency: 10 },
  capabilities: [
    { tool: 'bash', title: '执行命令', description: '跑一条命令', risk: 'write' as const },
    { tool: 'run', title: '跑', description: '同样的执行' },
  ],
  ...over,
})

const external = (over: Record<string, unknown> = {}) => ({
  protocolVersion: 1 as const,
  service: 'order',
  title: '订单服务',
  owner: 'B 团队',
  source: 'manual' as const,
  baseUrl: 'https://orders.example.com',
  capabilities: [{ tool: 'create', title: '下单', description: '创建订单' }],
  ...over,
})

describe('ServiceRegistry：登记与目录', () => {
  it('同一服务名、两个实例：目录只出一份能力，模型面名字由网关派生', async () => {
    const registry = new ServiceRegistry(config)
    await registry.register(internal())
    await registry.register(
      internal({ instance: { instanceId: 'cc-2', endpoint: 'http://10.0.0.2:9994' } }),
    )

    const catalog = await registry.catalog()
    const exec = catalog.filter((item) => item.service === 'exec')
    expect(exec).toHaveLength(2)
    expect(exec.map((item) => item.key)).toEqual(expect.arrayContaining(['bash', 'run']))
    expect(exec[0]!.name).toBe('bash')
    expect(exec[0]!.available).toBe(true)

    const service = (await registry.snapshot()).find((item) => item.service === 'exec')!
    expect(Object.keys(service.instances)).toEqual(expect.arrayContaining(['cc-1', 'cc-2']))
    expect(service.version).toBe(1)
  })

  it('清单没变是 no-op；改了才算新版本；删掉的能力转 deprecated 不进目录', async () => {
    const registry = new ServiceRegistry(config)
    const first = await registry.register(external())
    expect(first.version).toBe(1)
    expect(first.added).toEqual(['create'])

    const second = await registry.register(external())
    expect(second.version).toBe(1)
    expect(second.added).toEqual([])
    expect(second.changed).toEqual([])

    const changed = await registry.register(
      external({
        capabilities: [{ tool: 'create', title: '下单', description: '创建订单（已改）' }],
      }),
    )
    expect(changed.version).toBe(2)
    expect(changed.changed).toEqual(['create'])

    const removed = await registry.register(
      external({ capabilities: [{ tool: 'cancel', title: '取消', description: '取消订单' }] }),
    )
    expect(removed.version).toBe(3)
    expect(removed.removed).toEqual(['create'])
    const catalog = await registry.catalog()
    expect(catalog.map((item) => item.key)).not.toContain('create')
    expect(catalog.map((item) => item.key)).toContain('cancel')
  })

  it('按负载选实例：谁闲去谁那；失联后不再被选中', async () => {
    const registry = new ServiceRegistry({ ...config, staleAfterMs: 30 })
    await registry.register(internal())
    await registry.register(
      internal({ instance: { instanceId: 'cc-2', endpoint: 'http://10.0.0.2:9994' } }),
    )
    await registry.heartbeat({ service: 'exec', instanceId: 'cc-1', active: 9 })
    await registry.heartbeat({ service: 'exec', instanceId: 'cc-2', active: 0 })

    const picked = await registry.pick('bash')
    expect(picked?.instanceId).toBe('cc-2')

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await registry.pick('bash')).toBeNull()
  })

  it('外部服务固定 baseUrl；心跳不认识的实例让客户端重注册', async () => {
    const registry = new ServiceRegistry(config)
    await registry.register(external())

    expect(await registry.pick('create')).toMatchObject({
      endpoint: 'https://orders.example.com',
      instanceId: 'external',
    })
    expect(await registry.heartbeat({ service: 'order', instanceId: 'x', active: 0 })).toEqual({
      known: false,
    })
  })

  it('服务退役后能力消失、能力查不到', async () => {
    const registry = new ServiceRegistry(config)
    await registry.register(external())
    expect(await registry.find('create')).not.toBeNull()

    await registry.deregisterService('order')
    expect(await registry.find('create')).toBeNull()
    expect(await registry.catalog()).toEqual([])
  })

  it('实例摘除只摘流量，服务和能力都还在', async () => {
    const registry = new ServiceRegistry(config)
    await registry.register(internal())
    await registry.deregisterInstance('exec', 'cc-1')

    expect(await registry.pick('bash')).toBeNull()
    expect(await registry.find('bash')).not.toBeNull()
  })

  it('同名工具跨服务登记会被拒绝（能力 key 全局唯一）', async () => {
    const registry = new ServiceRegistry(config)
    await registry.register(internal())

    await expect(
      registry.register(
        external({
          service: 'other',
          capabilities: [{ tool: 'bash', title: '执行', description: '同名的 bash' }],
        }),
      ),
    ).rejects.toThrow(/已被服务 exec 占用/)
  })

  it('后台：列表不出凭据，只给 hasCredential；停用后目录清空、恢复后回来', async () => {
    const registry = new ServiceRegistry(config)
    await registry.register(
      external({
        auth: { mode: 'gateway-injected', header: 'x-api-key', credential: 'secret' },
      }),
    )

    const services = await registry.adminList()
    expect(services[0]!.auth).toMatchObject({
      mode: 'gateway-injected',
      header: 'x-api-key',
      hasCredential: true,
    })
    expect(services[0]!.auth).not.toHaveProperty('credential')

    await registry.setStatus('order', 'disabled')
    expect(await registry.catalog()).toEqual([])

    await registry.setStatus('order', 'active')
    expect((await registry.catalog()).map((item) => item.key)).toContain('create')
  })

  it('四个服务身份登记 17 个能力后，目录能列全（exec / web / files / memory）', async () => {
    const registry = new ServiceRegistry(config)
    const services = {
      exec: ['bash'],
      web: ['web-fetch', 'web-search', 'web-request'],
      files: [
        'file-list',
        'read-file',
        'write-file',
        'append-file',
        'replace-file',
        'file-search',
        'file-submit',
        'file-download',
        'workspace-files',
        'read-tool-result',
      ],
      memory: ['memory-save', 'memory-search', 'memory-forget'],
    }
    for (const [service, tools] of Object.entries(services)) {
      await registry.register({
        protocolVersion: 1,
        service,
        title: service,
        owner: '平台组',
        source: 'code',
        instance: { instanceId: `${service}-1`, endpoint: `http://10.0.0.1:9${service.length}` },
        capabilities: tools.map((tool) => ({ tool, title: tool, description: tool })),
      })
    }

    const catalog = await registry.catalog()
    expect(catalog).toHaveLength(17)
    expect(catalog.map((item) => item.key)).toEqual(
      expect.arrayContaining(['bash', 'web-fetch', 'read-tool-result', 'memory-search']),
    )
    expect(catalog.every((item) => item.available)).toBe(true)
  })
})
