import { describe, expect, it } from 'vitest'
import { PlannerStore, PlannerTools, type PlanOutput } from '../../src/modules/ai/core/beans/planner/index.js'
import { TOOL_KEYS } from '../../src/modules/ai/tools/tool-keys.js'
import { buildToolStackDeps, makeToolContext, silentLogger, specByKey } from '../helpers/ai-tool-stack.js'

/**
 * `plan-delete`（规划工具集之一）的单测：把**一个或多个**任务从清单里去掉
 * （**允许删空** —— 目标保留，之后还能用 `plan-create` 重新建）。
 *
 * 与另外三个规划工具共享"读清单 / 同轮串行 / 失败不改内存"的机制（`planner/store.ts`）。
 */
const SEED = {
  goal: '整理周报',
  revision: 1,
  tasks: [
    { id: 'd1', title: '取待办', status: 'pending' },
    { id: 'd2', title: '分组', status: 'pending' },
    { id: 'd3', title: '写周报', status: 'pending' },
  ],
}

const build = (latestPlan: unknown = SEED) => {
  const deps = buildToolStackDeps()
  const timelines = { latestPlan: async () => latestPlan, findToolOutput: async () => null }
  const spec = specByKey(new PlannerTools(new PlannerStore(timelines as never)), TOOL_KEYS.planDelete)
  const envelope = {
    conversationId: 'conv-1',
    parentRunId: 'run-1',
    triggeredBy: 'user-1',
    isAdmin: false,
    depth: 0,
    agentKey: 'assistant',
    rootAgentKey: 'assistant',
    model: {},
    childToolbox: new Map(),
    skills: [],
  }
  return { deps, spec, timeline: timelines, envelope }
}

describe('plan-delete（删除任务，支持一次删除多个）', () => {
  it('批量删除：一次删掉多个，剩下的原样保留', async () => {
    const { deps, spec, envelope } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const result = (await spec.exec({ ids: ['d1', 'd3'] }, ctx as never)) as PlanOutput

    expect(result.revision).toBe(2)
    expect(result.tasks.map((task) => task.id)).toEqual(['d2'])
    expect(result.goal).toBe('整理周报')
    expect(result.summary).toContain('删除 d1')
    expect(result.summary).toContain('删除 d3')
  })

  it('删空是允许的：任务清空但**目标保留**', async () => {
    const { deps, spec, envelope } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const result = (await spec.exec({ ids: ['d1', 'd2', 'd3'] }, ctx as never)) as PlanOutput
    expect(result.tasks).toEqual([])
    expect(result.goal).toBe('整理周报')
    expect(result.summary).toContain('共 0 项')
  })

  it('未知 id → 拒绝，并把当前清单列出来', async () => {
    const { deps, spec, envelope } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    await expect(spec.exec({ ids: ['zzz'] }, ctx as never)).rejects.toThrowError(
      /任务不存在：zzz（当前清单：d1、d2、d3）/,
    )
  })

  it('还没有清单 → precheck-failed', async () => {
    const { deps, spec, envelope } = build(null)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    await expect(spec.exec({ ids: ['d1'] }, ctx as never)).rejects.toThrowError(/还没有任务清单/)
  })

  it('它是"只给主 agent"的工具，且 ids 至少 1 个、最多 50 个', () => {
    const { spec } = build()
    expect(spec.key).toBe(TOOL_KEYS.planDelete)
    expect(spec.child).toBe('deny')
    expect(spec.params.safeParse({ ids: [] }).success).toBe(false)
    expect(spec.params.safeParse({ ids: Array.from({ length: 51 }, (_, i) => `d${i}`) }).success).toBe(
      false,
    )
    expect(spec.params.safeParse({ ids: ['d1'] }).success).toBe(true)
    expect(typeof silentLogger.info).toBe('function')
  })
})
