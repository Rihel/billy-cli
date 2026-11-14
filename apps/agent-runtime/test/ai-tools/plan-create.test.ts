import { describe, expect, it } from 'vitest'
import {
  PlannerStore,
  PlannerTools,
  type PlanOutput,
} from '../../src/modules/ai/tools/planner/index.js'
import { TOOL_KEYS } from '../../src/modules/ai/core/tools/tool-keys.js'
import {
  buildToolStackDeps,
  makeToolContext,
  silentLogger,
  specByKey,
} from '../helpers/ai-tool-stack.js'

/**
 * `plan-create`（规划工具集之一）的单测（设计 §5.9 的标准测试集要求每个工具有自己的测试文件）。
 *
 * 它**自己不写库**（出参是纯数据），所以最容易测：给一个假的时间线仓储，直接调 `exec`。
 * 与另外三个规划工具共享"读清单 / 同轮串行 / 失败不改内存"的机制（`planner/store.ts`），
 * 这里只钉 `plan-create` 自己的语义：首建、**追加**、id 唯一、总数上限、缺信封拒绝。
 */
const T1 = { id: 't1', title: '取最近的待办', status: 'completed' }

const build = (latestPlan: unknown = null) => {
  const deps = buildToolStackDeps()
  const timelines = { latestPlan: async () => latestPlan, findToolOutput: async () => null }
  const spec = specByKey(
    new PlannerTools(new PlannerStore(timelines as never)),
    TOOL_KEYS.planCreate,
  )
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

describe('plan-create（创建任务清单；已有清单时是追加）', () => {
  it('首次创建：补 id 与默认状态，给一句摘要，revision 从 1 开始', async () => {
    const { deps, spec, envelope } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const result = (await spec.exec(
      { goal: '整理周报', tasks: [{ title: '取待办' }, { id: 't2', title: '分组' }] },
      ctx as never,
    )) as PlanOutput
    expect(result.revision).toBe(1)
    expect(result.tasks.map((task) => task.id)).toEqual(['task-1', 't2'])
    expect(result.tasks.every((task) => task.status === 'pending')).toBe(true)
    // 语义变了：create 每次都报"本次新增了哪些任务"（旧的全量覆盖语义下首建才显示"首次创建"）
    expect(result.summary).toContain('新增 task-1')
    expect(result.summary).toContain('新增 t2')
  })

  it('已有清单时是**追加**：原任务保留、未给的目标沿用、revision 递增', async () => {
    const { deps, spec, envelope } = build({
      goal: '整理周报',
      revision: 3,
      tasks: [T1],
    })
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    const result = (await spec.exec(
      { tasks: [{ id: 't2', title: '新增项' }] },
      ctx as never,
    )) as PlanOutput
    expect(result.revision).toBe(4)
    // 目标沿用上一版；t1 原样保留（**不**因为"这一版没出现"就被删掉）
    expect(result.goal).toBe('整理周报')
    expect(result.tasks).toEqual([T1, { id: 't2', title: '新增项', status: 'pending' }])
    expect(result.summary).toContain('新增 t2')
  })

  it('第一次创建必须给 goal：无从沿用就明确拒绝', async () => {
    const { deps, spec, envelope } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    await expect(spec.exec({ tasks: [{ title: '没有目标' }] }, ctx as never)).rejects.toThrowError(
      /必须给 goal/,
    )
  })

  it('id 重复 → 明确拒绝（否则"改状态"会变成掷骰子）', async () => {
    const { deps, spec, envelope } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    // 同一批里重复
    await expect(
      spec.exec(
        {
          goal: 'x',
          tasks: [
            { id: 't1', title: 'a' },
            { id: 't1', title: 'b' },
          ],
        },
        ctx as never,
      ),
    ).rejects.toThrowError(/id 重复/)
    // 与已有清单重复（追加时同样不许撞 id）
    const existing = build({ goal: 'g', revision: 1, tasks: [T1] })
    const existingSettings = await existing.deps.config.settings(existing.spec)
    await expect(
      existing.spec.exec(
        { tasks: [{ id: 't1', title: 'b' }] },
        makeToolContext({
          spec: existing.spec,
          settings: existingSettings,
          envelope: existing.envelope,
        }) as never,
      ),
    ).rejects.toThrowError(/id 重复/)
  })

  it('单份清单总数上限：已有 100 项时再加 1 项 → 拒绝并说明现状', async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({
      id: `e${index + 1}`,
      title: `已有任务 ${index + 1}`,
      status: 'pending' as const,
    }))
    const { deps, spec, envelope } = build({ goal: 'g', revision: 1, tasks: full })
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope })
    await expect(
      spec.exec({ tasks: [{ id: 'n1', title: '再来一项' }] }, ctx as never),
    ).rejects.toThrowError(/最多 100 项/)
  })

  it('没有运行时信封 → 拒绝并说明（不伪造上下文、不改任何状态）', async () => {
    const { deps, spec } = build()
    const settings = await deps.config.settings(spec)
    const ctx = makeToolContext({ spec, settings, envelope: null, caller: null })
    await expect(
      spec.exec({ goal: 'x', tasks: [{ title: 'a' }] }, ctx as never),
    ).rejects.toThrowError(/缺少运行时上下文/)
  })

  it('它是"只给主 agent"的工具，且一次最多建 30 项、至少 1 项', () => {
    const { spec } = build()
    expect(spec.key).toBe(TOOL_KEYS.planCreate)
    expect(spec.child).toBe('deny')
    expect(spec.params.safeParse({ goal: 'g', tasks: [] }).success).toBe(false)
    expect(
      spec.params.safeParse({
        goal: 'g',
        tasks: Array.from({ length: 31 }, (_, i) => ({ title: `t${i}` })),
      }).success,
    ).toBe(false)
    expect(typeof silentLogger.info).toBe('function')
  })
})
