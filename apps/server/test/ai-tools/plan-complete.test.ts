import { describe, expect, it } from 'vitest'
import { PlannerStore, PlannerTools, type PlanOutput } from '../../src/modules/ai/tools/planner/index.js'
import { TOOL_KEYS } from '../../src/modules/ai/core/tools/tool-keys.js'
import { buildToolStackDeps, makeToolContext, silentLogger, specByKey } from '../helpers/ai-tool-stack.js'

/**
 * `plan-complete`（规划工具集之一）的单测：把**一个或多个**做完的任务标成 `completed`
 * （幂等；`note` 写进这些任务的备注）。
 *
 * 与另外三个规划工具共享"读清单 / 同轮串行 / 失败不改内存"的机制（`planner/store.ts`）。
 */
const SEED = {
  goal: '整理周报',
  revision: 1,
  tasks: [
    { id: 'c1', title: '起草', status: 'in_progress' },
    { id: 'c2', title: '校对', status: 'pending' },
    { id: 'c3', title: '发布', status: 'completed' },
  ],
}

const build = (latestPlan: unknown = SEED) => {
  const deps = buildToolStackDeps()
  const timelines = { latestPlan: async () => latestPlan, findToolOutput: async () => null }
  const spec = specByKey(new PlannerTools(new PlannerStore(timelines as never)), TOOL_KEYS.planComplete)
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

describe('plan-complete（完成任务，支持一次完成多个）', () => {
  it('批量完成：一次标掉多个，note 写进这些任务的备注', async () => {
    const { deps, spec, envelope } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const result = (await spec.exec(
      { ids: ['c1', 'c2'], note: '结论：已核对' },
      ctx as never,
    )) as PlanOutput

    expect(result.revision).toBe(2)
    expect(result.tasks.map((task) => [task.id, task.status])).toEqual([
      ['c1', 'completed'],
      ['c2', 'completed'],
      ['c3', 'completed'],
    ])
    // note 落到被标的这几项上（c3 没被这次调用点到，不写）
    expect(result.tasks[0].note).toBe('结论：已核对')
    expect(result.tasks[1].note).toBe('结论：已核对')
    expect(result.tasks[2].note).toBeUndefined()
    expect(result.summary).toContain('共 3 项')
    expect(result.summary).toContain('已完成 3 项')
    expect(result.summary).toContain('c1 in_progress→completed')
    expect(result.summary).toContain('c2 pending→completed')
  })

  it('幂等：已经是 completed 的再标一次不算错（出参说明"无变化"），revision 仍 +1', async () => {
    const { deps, spec, envelope } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const result = (await spec.exec({ ids: ['c3'] }, ctx as never)) as PlanOutput
    expect(result.revision).toBe(2)
    expect(result.tasks.map((task) => task.status)).toEqual(['in_progress', 'pending', 'completed'])
    expect(result.summary).toContain('本来就是已完成')
  })

  it('未知 id → 拒绝，并把当前清单列出来（便于模型改一版）', async () => {
    const { deps, spec, envelope } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    await expect(spec.exec({ ids: ['c1', 'zzz'] }, ctx as never)).rejects.toThrowError(
      /任务不存在：zzz（当前清单：c1、c2、c3）/,
    )
  })

  it('还没有清单 → precheck-failed', async () => {
    const { deps, spec, envelope } = build(null)
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    await expect(spec.exec({ ids: ['c1'] }, ctx as never)).rejects.toThrowError(/还没有任务清单/)
  })

  it('它是"只给主 agent"的工具，且 ids 至少 1 个、最多 50 个', () => {
    const { spec } = build()
    expect(spec.key).toBe(TOOL_KEYS.planComplete)
    expect(spec.child).toBe('deny')
    expect(spec.params.safeParse({ ids: [] }).success).toBe(false)
    expect(spec.params.safeParse({ ids: Array.from({ length: 51 }, (_, i) => `c${i}`) }).success).toBe(
      false,
    )
    expect(spec.params.safeParse({ ids: ['c1'], note: '结论' }).success).toBe(true)
    expect(typeof silentLogger.info).toBe('function')
  })
})
