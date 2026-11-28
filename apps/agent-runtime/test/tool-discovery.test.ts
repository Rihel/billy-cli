import { describe, expect, it, vi } from 'vitest'
import { ToolDiscoveryStore } from '../src/modules/ai/tools/engine/tool-discovery.store.js'
import { ToolGateway } from '../src/modules/ai/tools/engine/tool.gateway.js'
import { TaskTool } from '../src/modules/ai/tools/builtin/task.tool.js'
import type { ToolCallInput } from '../src/modules/ai/tools/engine/tools.types.js'
import { buildToolStackDeps, silentLogger, specByKey } from './helpers/ai-tool-stack.js'

/** 只实现 getJson / setJson 的内存 Redis（TTL 不参与断言） */
const fakeRedis = () => {
  const map = new Map<string, unknown>()
  return {
    getJson: async (key: string) => map.get(key) ?? null,
    setJson: async (key: string, value: unknown) => {
      map.set(key, value)
    },
  } as never
}

const envelope = {
  conversationId: 'conv-1',
  workspaceConversationId: 'conv-1',
  parentRunId: 'run-1',
  triggeredBy: 'user-1',
  isAdmin: false,
  agentKey: 'assistant',
  rootAgentKey: 'assistant',
  depth: 0,
} as never

const call = (): ToolCallInput =>
  ({ callId: 'call-1', envelope, log: silentLogger as never }) as ToolCallInput

describe('ToolDiscoveryStore（搜到过的外部工具）', () => {
  it('按会话累积、去重、保留最近 50 个', async () => {
    const store = new ToolDiscoveryStore(fakeRedis())
    expect(await store.list('c-1')).toEqual([])

    await store.remember('c-1', ['maps-weather', 'maps-geo'])
    await store.remember('c-1', ['maps-weather', 'maps-direction'])

    expect(await store.list('c-1')).toEqual(['maps-weather', 'maps-geo', 'maps-direction'])
    // 不同会话互不影响
    expect(await store.list('c-2')).toEqual([])

    await store.remember(
      'c-1',
      Array.from({ length: 60 }, (_, index) => `tool-${index}`),
    )
    const kept = await store.list('c-1')
    expect(kept).toHaveLength(50)
    expect(kept.at(-1)).toBe('tool-59')
  })
})

describe('ToolGateway：tool-search 命中写进会话', () => {
  it('检索成功后记下命中的 key；非检索工具不写', async () => {
    const deps = buildToolStackDeps()
    const discovery = new ToolDiscoveryStore(fakeRedis())
    const remote = {
      supports: () => true,
      invoke: vi.fn(async () => ({
        ok: true,
        data: { items: [{ key: 'maps-weather' }, { key: 'maps-geo' }] },
      })),
    }
    const gateway = new ToolGateway(
      deps.config,
      silentLogger as never,
      [],
      deps.clock,
      remote as never,
      discovery,
    )

    const search = specByKey(new TaskTool(), 'tool-search')
    await gateway.invoke(search, { query: '天气', reason: '查一下天气' }, call())
    expect(await discovery.list('conv-1')).toEqual(['maps-weather', 'maps-geo'])

    const wait = specByKey(new TaskTool(), 'wait-task')
    await gateway.invoke(wait, { taskId: 't-1', reason: '等任务结果' }, call())
    expect(await discovery.list('conv-1')).toEqual(['maps-weather', 'maps-geo'])
  })
})
