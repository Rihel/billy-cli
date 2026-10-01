import { describe, expect, it } from 'vitest'
import { PlannerStore, PlannerTools, type PlanOutput } from '../../src/modules/ai/tools/planner/index.js'
import { TOOL_KEYS } from '../../src/modules/ai/core/tools/tool-keys.js'
import { buildToolStackDeps, makeToolContext, silentLogger, specByKey } from '../helpers/ai-tool-stack.js'

/**
 * `plan-reorder`（规划工具集之一）的单测：**改顺序**（`order` 必须是全部 id 的一个排列）
 * 与**就地修改**（`updates` 改标题 / 备注 / 状态，开始做某一项也用它标 `in_progress`）。
 *
 * 与另外三个规划工具共享"读清单 / 同轮串行 / 失败不改内存"的机制（`planner/store.ts`）。
 */
const SEED = {
  goal: '整理周报',
  revision: 1,
  tasks: [
    { id: 'a', title: '写方案', status: 'pending' },
    { id: 'b', title: '拉数据', status: 'pending' },
  ],
}

const build = (latestPlan: unknown = SEED) => {
  const deps = buildToolStackDeps()
  const timelines = { latestPlan: async () => latestPlan, findToolOutput: async () => null }
  const spec = specByKey(new PlannerTools(new PlannerStore(timelines as never)), TOOL_KEYS.planReorder)
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

describe('plan-reorder（重排任务清单：顺序 + 就地修改）', () => {
  it('还没有清单 → precheck-failed（并给出下一步建议）', async () => {
    const { deps, spec, envelope } = build(null)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    await expect(spec.exec({ order: ['a'] }, ctx as never)).rejects.toThrowError(/还没有任务清单/)
  })

  it('order 必须与当前清单一一对应：少了 / 多了 / 重复都拒绝', async () => {
    const { deps, spec, envelope } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })

    // 少了 b
    await expect(spec.exec({ order: ['a'] }, ctx as never)).rejects.toThrowError(/一一对应/)
    // 多了 c
    await expect(spec.exec({ order: ['a', 'b', 'c'] }, ctx as never)).rejects.toThrowError(/一一对应/)
    // 有重复
    await expect(spec.exec({ order: ['a', 'a'] }, ctx as never)).rejects.toThrowError(/一一对应/)
    // 失败不改内存：随后的合法调用仍能读到干净状态
    const result = (await spec.exec({ order: ['b', 'a'] }, ctx as never)) as PlanOutput
    expect(result.tasks.map((task) => task.id)).toEqual(['b', 'a'])
    expect(result.revision).toBe(2)
  })

  it('updates 里的未知 id → 拒绝（不可能改一项不存在的任务）', async () => {
    const { deps, spec, envelope } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    await expect(
      spec.exec({ updates: [{ id: 'zzz', title: '不存在' }] }, ctx as never),
    ).rejects.toThrowError(/任务不存在/)
  })

  it('合法：order 重排 + updates 改标题 / 标 in_progress，摘要写清这次改了什么', async () => {
    const { deps, spec, envelope } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const result = (await spec.exec(
      {
        order: ['b', 'a'],
        updates: [
          { id: 'b', status: 'in_progress' },
          { id: 'a', title: '写方案（v2）' },
        ],
      },
      ctx as never,
    )) as PlanOutput

    expect(result.revision).toBe(2)
    // 重排在内、改内容也在内
    expect(result.tasks).toEqual([
      { id: 'b', title: '拉数据', status: 'in_progress' },
      { id: 'a', title: '写方案（v2）', status: 'pending' },
    ])
    expect(result.summary).toContain('顺序已重排')
    expect(result.summary).toContain('b pending→in_progress')
    expect(result.summary).toContain('a 标题已更新')
    expect(result.goal).toBe('整理周报')
  })

  it('只给 updates：就地改备注，顺序不变', async () => {
    const { deps, spec, envelope } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const result = (await spec.exec(
      { updates: [{ id: 'a', note: '阻塞：等上游数据' }] },
      ctx as never,
    )) as PlanOutput
    expect(result.tasks.map((task) => task.id)).toEqual(['a', 'b'])
    expect(result.tasks[0].note).toBe('阻塞：等上游数据')
    expect(result.summary).toContain('a 备注已更新')
  })

  it('它是"只给主 agent"的工具，且 order / updates 至少要给一个', () => {
    const { spec } = build()
    expect(spec.key).toBe(TOOL_KEYS.planReorder)
    expect(spec.child).toBe('deny')
    expect(spec.params.safeParse({}).success).toBe(false)
    expect(spec.params.safeParse({ order: ['a', 'b'] }).success).toBe(true)
    expect(spec.params.safeParse({ updates: [{ id: 'a', status: 'in_progress' }] }).success).toBe(true)
    expect(typeof silentLogger.info).toBe('function')
  })
})
