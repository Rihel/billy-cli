import { describe, expect, it, vi } from 'vitest'
import type { CapabilityInfo } from '@repo/contracts'
import { createCapabilityTool } from '../src/modules/ai/core/tools/external.tool.js'
import type { RemoteToolInvoker } from '../src/modules/ai/core/tools/tool.ports.js'
import type { ToolCallInput } from '../src/modules/ai/core/tools/tools.types.js'

const capability: CapabilityInfo = {
  key: 'maps-weather',
  name: 'maps-weather',
  service: 'amap-mcp',
  source: 'manual',
  tool: 'maps-weather',
  title: '查天气',
  description: '按城市查天气',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  risk: 'read',
  scope: 'all',
  available: true,
  tags: [],
}

const envelope = {
  conversationId: 'c-1',
  workspaceConversationId: 'c-1',
  parentRunId: 'run-1',
  triggeredBy: 'u-1',
  isAdmin: false,
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
  depth: 0,
}

const call = (over: Partial<ToolCallInput> = {}): ToolCallInput =>
  ({
    callId: 'call-1',
    envelope,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  }) as unknown as ToolCallInput

const remoteStub = (outcome: unknown) =>
  ({ supports: () => true, invoke: vi.fn(async () => outcome) }) as unknown as RemoteToolInvoker

describe('目录能力（外部服务 → 模型工具面）', () => {
  it('生成的 spec 带目录里的参数定义与说明', () => {
    const tool = createCapabilityTool(capability, remoteStub({ ok: true, data: {} }))
    expect(tool.key).toBe('maps-weather')
    expect(tool.spec).toMatchObject({
      title: '查天气',
      description: '按城市查天气',
      category: 'external',
      scope: 'all',
    })
    expect(tool.spec.params.safeParse({ city: '北京' }).success).toBe(true)
    // 模型面要求必填 reason（执行前剥掉，不传给能力）
    expect(tool.spec.modelParams?.safeParse({ city: '北京' }).success).toBe(false)
    expect(tool.spec.modelParams?.safeParse({ city: '北京', reason: '查一下天气' }).success).toBe(
      true,
    )
  })

  it('执行走 RemoteToolInvoker（工具名 + 身份 + deadline）', async () => {
    const remote = remoteStub({ ok: true, data: { city: '北京' } })
    const tool = createCapabilityTool(capability, remote)
    const outcome = await tool.run({ city: '北京', reason: '查天气' }, call())

    expect(outcome).toEqual({ ok: true, data: { city: '北京' } })
    expect(remote.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        toolKey: 'maps-weather',
        input: { city: '北京' },
        deadlineMs: 310_000,
        caller: expect.objectContaining({ conversationId: 'c-1', runId: 'run-1' }),
      }),
    )
  })

  it('没有网关 / 没有身份时给出可读结论，不抛异常', async () => {
    const noRemote = createCapabilityTool(capability, null)
    expect(await noRemote.run({ city: '北京' }, call())).toMatchObject({
      ok: false,
      reason: 'disabled',
    })

    const tool = createCapabilityTool(capability, remoteStub({ ok: true, data: {} }))
    expect(await tool.run({ city: '北京' }, call({ envelope: null }))).toMatchObject({
      ok: false,
      reason: 'forbidden',
    })
  })
})
