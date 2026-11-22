import { describe, expect, it, vi } from 'vitest'
import type { CapabilityInvokeRequest } from '@repo/contracts'
import type { ToolGatewayConfigValue } from '../src/config/app-config.js'
import { CapabilityRegistryController } from '../src/registry/capability-registry.controller.js'
import type { CapabilityPolicyService } from '../src/registry/capability.policy.js'
import type { ServiceInvoker } from '../src/registry/service.invoker.js'
import { ServiceRegistry } from '../src/registry/service.registry.js'
import type { ToolAuditService } from '../src/audit/tool.audit.js'

const config: ToolGatewayConfigValue = {
  internalToken: 'token',
  staleAfterMs: 30_000,
  invokeTimeoutMs: 2_000,
  rateLimitPerMinute: 60,
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

const invokeBody = (capability: string, input: Record<string, unknown>) => ({
  capability,
  input,
  caller,
  deadlineMs: 10_000,
})

const build = () => {
  const snapshot = {
    version: 1 as const,
    id: 't-1',
    state: 'succeeded' as const,
    result: { ok: true as const, data: { stdout: 'hi' } },
  }
  const getTask = vi.fn(async () => snapshot)
  const cancelTask = vi.fn(async () => ({
    version: 1 as const,
    id: 't-1',
    state: 'canceled' as const,
  }))
  const precheck = vi.fn(async (_found, _caller, input) => ({ ok: true as const, input }))
  const record = vi.fn(async () => undefined)
  const controller = new CapabilityRegistryController(
    {} as ServiceRegistry,
    { getTask, cancelTask } as unknown as ServiceInvoker,
    { precheck } as unknown as CapabilityPolicyService,
    { record } as unknown as ToolAuditService,
  )
  return { controller, getTask, cancelTask, precheck, record, snapshot }
}

describe('网关内建任务工具（wait-task / cancel-task）', () => {
  it('内建能力始终在目录里（service=gateway，available=true）', async () => {
    const registry = new ServiceRegistry(config)
    const catalog = await registry.catalog()
    const wait = catalog.find((item) => item.key === 'wait-task')
    const cancel = catalog.find((item) => item.key === 'cancel-task')

    expect(wait).toMatchObject({ service: 'gateway', name: 'wait-task', available: true })
    expect(wait?.inputSchema).toMatchObject({ type: 'object' })
    expect(cancel).toMatchObject({ service: 'gateway', risk: 'write', available: true })

    const visible = await registry.listFor({
      isAdmin: false,
      agentKey: 'assistant',
      rootAgentKey: 'assistant',
    })
    expect(visible.map((item) => item.key)).toEqual(
      expect.arrayContaining(['wait-task', 'cancel-task']),
    )
  })

  it('服务登记不能占用内建工具名（409）', async () => {
    const registry = new ServiceRegistry(config)
    await expect(
      registry.register({
        protocolVersion: 1,
        service: 'task-fake',
        title: '假任务服务',
        owner: '测试',
        source: 'manual',
        baseUrl: 'https://task.example.com',
        capabilities: [{ tool: 'wait-task', title: '等任务', description: '冒充内建工具' }],
      }),
    ).rejects.toThrow('网关内建能力')
  })

  it('调用 wait-task 直接查任务索引，不转发服务', async () => {
    const { controller, getTask, record, snapshot } = build()
    const result = await controller.invoke(
      invokeBody('wait-task', { taskId: 't-1', waitMs: 30_000 }),
    )

    expect(getTask).toHaveBeenCalledWith({ taskId: 't-1', waitMs: 30_000 })
    expect(result).toMatchObject({
      capability: 'wait-task',
      service: 'gateway',
      outcome: { ok: true, data: snapshot },
    })
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('cancel-task 幂等取消，返回最新快照', async () => {
    const { controller, cancelTask } = build()
    const result = await controller.invoke(invokeBody('cancel-task', { taskId: 't-1' }))

    expect(cancelTask).toHaveBeenCalledWith('t-1')
    expect(result.outcome).toMatchObject({ ok: true, data: { state: 'canceled' } })
  })

  it('治理拒绝时直接返回结论（不查任务）', async () => {
    const { controller, precheck, getTask } = build()
    precheck.mockResolvedValueOnce({
      ok: false,
      outcome: { ok: false, reason: 'forbidden', message: '无权调用' },
    })

    const result = await controller.invoke(invokeBody('wait-task', { taskId: 't-1' }))
    expect(getTask).not.toHaveBeenCalled()
    expect(result.outcome).toMatchObject({ ok: false, reason: 'forbidden' })
  })
})

describe('级联取消（停止对话时只取消 session 任务）', () => {
  it('按 runId 记任务并去重，读回来是任务列表', async () => {
    const registry = new ServiceRegistry(config)
    await registry.saveRunTask('run-1', 't-1', 60)
    await registry.saveRunTask('run-1', 't-2', 60)
    await registry.saveRunTask('run-1', 't-1', 60)

    expect(await registry.runTaskIds('run-1')).toEqual(['t-1', 't-2'])
    expect(await registry.runTaskIds('run-unknown')).toEqual([])
  })

  it('cancel-run 逐个取消，只统计真正变为 canceled 的', async () => {
    const cancelTask = vi
      .fn()
      .mockResolvedValueOnce({ version: 1, id: 't-1', state: 'canceled' })
      .mockResolvedValueOnce({ version: 1, id: 't-2', state: 'succeeded' })
    const controller = new CapabilityRegistryController(
      { runTaskIds: async () => ['t-1', 't-2'] } as unknown as ServiceRegistry,
      { cancelTask } as unknown as ServiceInvoker,
      {} as CapabilityPolicyService,
      { record: vi.fn() } as unknown as ToolAuditService,
      { taskIdsForRun: async () => [] } as unknown as ToolEffectLedger,
      { warn: vi.fn(), error: vi.fn(), log: vi.fn() } as never,
    )

    const result = await controller.cancelRun({ runId: 'run-1' })

    expect(cancelTask.mock.calls.map(([taskId]) => taskId)).toEqual(['t-1', 't-2'])
    expect(result).toEqual({ targets: 2, canceled: 1, degraded: false })
  })

  it('台账查询失败时明确降级，不能谎称「全部取消」', async () => {
    const cancelTask = vi.fn().mockResolvedValue({ version: 1, id: 't-1', state: 'canceled' })
    const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() }
    const controller = new CapabilityRegistryController(
      { runTaskIds: async () => ['t-1'] } as unknown as ServiceRegistry,
      { cancelTask } as unknown as ServiceInvoker,
      {} as CapabilityPolicyService,
      { record: vi.fn() } as unknown as ToolAuditService,
      {
        taskIdsForRun: async () => {
          throw new Error('db down')
        },
      } as unknown as ToolEffectLedger,
      logger as never,
    )

    const result = await controller.cancelRun({ runId: 'run-1' })

    expect(result).toEqual({ targets: 1, canceled: 1, degraded: true })
    expect(logger.error).toHaveBeenCalled()
  })

  it('Redis 映射丢了也能从台账兜底取消（并去重）', async () => {
    const cancelTask = vi.fn().mockResolvedValue({ version: 1, id: 't-x', state: 'canceled' })
    const controller = new CapabilityRegistryController(
      // 映射只剩 t-1（t-2 那次写 Redis 失败了）
      { runTaskIds: async () => ['t-1'] } as unknown as ServiceRegistry,
      { cancelTask } as unknown as ServiceInvoker,
      {} as CapabilityPolicyService,
      { record: vi.fn() } as unknown as ToolAuditService,
      // 台账记得 t-1（重复）与 t-2（映射里没有）
      { taskIdsForRun: async () => ['t-1', 't-2'] } as unknown as ToolEffectLedger,
      { warn: vi.fn(), error: vi.fn(), log: vi.fn() } as never,
    )

    const result = await controller.cancelRun({ runId: 'run-1' })

    expect(cancelTask.mock.calls.map(([taskId]) => taskId)).toEqual(['t-1', 't-2'])
    expect(result).toEqual({ targets: 2, canceled: 2, degraded: false })
  })
})

describe('网关内建工具检索（BM25）', () => {
  const capability = (key: string, title: string, description: string) => ({
    key,
    name: key,
    service: 'demo',
    tool: key,
    title,
    description,
    inputSchema: { type: 'object' },
    risk: 'read' as const,
    scope: 'all' as const,
    available: true,
    tags: [],
  })

  const buildSearch = (listFor: () => Promise<unknown[]>) =>
    new CapabilityRegistryController(
      { listFor } as unknown as ServiceRegistry,
      {} as ServiceInvoker,
      {
        precheck: async (_found, _caller, input) => ({ ok: true as const, input }),
      } as unknown as CapabilityPolicyService,
      { record: vi.fn() } as unknown as ToolAuditService,
    )

  it('在当前身份可见目录里按中文检索，排除检索工具自身', async () => {
    const controller = buildSearch(async () => [
      capability('maps-weather', '查天气', '按城市查询指定城市的天气'),
      capability('file-list', '列文件', '列出会话工作区里的文件'),
      capability('tool-search', '检索工具', '检索工具自身'),
    ])

    const result = await controller.invoke(invokeBody('tool-search', { query: '明天天气怎么样' }))
    expect(result.outcome.ok).toBe(true)
    const data = (result.outcome as { data: { total: number; items: Array<{ key: string }> } }).data
    expect(data.items[0]?.key).toBe('maps-weather')
    expect(data.items.map((item) => item.key)).not.toContain('tool-search')
  })

  it('无命中返回空列表 + 提示', async () => {
    const controller = buildSearch(async () => [capability('bash', '执行命令', '跑命令')])
    const result = await controller.invoke(invokeBody('tool-search', { query: '量子纠缠' }))
    const data = (result.outcome as { data: { total: number; notice?: string } }).data
    expect(data.total).toBe(0)
    expect(data.notice).toBeTruthy()
  })
})
