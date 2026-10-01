import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PlanSummaryCard } from '../src/app/(standalone)/main/ai/chat/plan-summary-card.tsx'
import {
  PlanPanel,
  collectMessagePlan,
  conversationPlanOf,
  describeChange,
  toPlanSnapshot,
  type Plan,
  type PlanSourcePart,
  type PlanStatus,
} from '../src/app/(standalone)/main/ai/chat/plan-panel.tsx'

/**
 * 计划面板：出参容错 + "当前计划"的取舍规则 + 卡片渲染（node 环境 SSR 冒烟）。
 *
 * 钉住四件会直接影响用户看到什么的事：
 * 1. 出参是 `{ plan, change }`、裸计划还是 JSON 字符串，都要能认（字符串不是 JSON 就不硬画卡片）；
 * 2. 一条消息里只渲染一份当前计划（按 revision 取最新），更早的版本进"变更历史"；
 * 3. 历史（`data-plan`）与实时（`plan-*` 工具）走同一个入口，同一版只算一次；
 * 4. 卡片正文真的有目标 / 进度 / 任务 / 变更摘要。
 */

const snapshot = (revision: number, statuses: PlanStatus[]) => ({
  plan: {
    goal: '整理待办周报',
    revision,
    tasks: statuses.map((status, index) => ({
      id: `t${index + 1}`,
      title: `任务 ${index + 1}`,
      status,
    })),
  },
  change: { op: 'update-task', taskId: 't1', status: statuses[0] ?? 'pending' },
})

const part = (value: Partial<PlanSourcePart> & { type: string }): PlanSourcePart => value

describe('toPlanSnapshot', () => {
  it('认 `{ plan, change }`、裸计划与 JSON 字符串三种出参', () => {
    const wrapped = snapshot(2, ['done', 'in_progress'])
    expect(toPlanSnapshot(wrapped)?.plan.revision).toBe(2)
    expect(toPlanSnapshot(wrapped.plan)?.plan.goal).toBe('整理待办周报')
    expect(toPlanSnapshot(JSON.stringify(wrapped))?.plan.tasks).toHaveLength(2)
  })

  it('兼容旧 write-plan 的 `{ goal, steps }`（steps 当任务，缺状态按待办）', () => {
    const legacy = toPlanSnapshot({
      goal: '旧计划',
      steps: [{ id: 's1', title: '第一步' }, { id: 's2', title: '第二步', status: 'completed' }],
    })
    expect(legacy?.plan.goal).toBe('旧计划')
    expect(legacy?.plan.revision).toBe(0)
    expect(legacy?.plan.tasks).toEqual([
      { id: 's1', title: '第一步', status: 'pending' },
      { id: 's2', title: '第二步', status: 'done' },
    ])
  })

  it('认不出的出参返回 null（不硬画一张空计划卡）', () => {
    expect(toPlanSnapshot(null)).toBeNull()
    expect(toPlanSnapshot('不是 JSON 的一段文本')).toBeNull()
    expect(toPlanSnapshot({ summary: '没有计划' })).toBeNull()
  })
})

describe('collectMessagePlan', () => {
  it('实时形态一（`dynamic-tool` + `toolName`）：取 revision 最高的出参，其余进变更历史', () => {
    const messagePlan = collectMessagePlan([
      part({ type: 'text' }),
      part({
        type: 'dynamic-tool',
        toolName: 'plan-create',
        state: 'output-available',
        output: snapshot(1, ['pending']),
      }),
      part({
        type: 'dynamic-tool',
        toolName: 'plan-update-task',
        state: 'output-available',
        output: snapshot(2, ['pending', 'done']),
      }),
    ])

    expect(messagePlan?.current.plan.revision).toBe(2)
    expect(messagePlan?.history.map((item) => item.plan.revision)).toEqual([1])
    expect(messagePlan?.consumed).toEqual([1, 2])
  })

  it('历史：`data-plan` part 同样进同一个入口，按 revision 取最新', () => {
    const messagePlan = collectMessagePlan([
      part({ type: 'data-plan', id: 'plan-5', data: snapshot(1, ['pending']) }),
      part({ type: 'text' }),
      part({ type: 'data-plan', id: 'plan-9', data: snapshot(3, ['done']) }),
    ])

    expect(messagePlan?.current.plan.revision).toBe(3)
    expect(messagePlan?.history.map((item) => item.plan.revision)).toEqual([1])
    expect(messagePlan?.consumed).toEqual([0, 2])
  })

  it('同一版同时出现在工具出参与 data-plan 时只算一次，并保留有 change 的那条', () => {
    const messagePlan = collectMessagePlan([
      part({
        type: 'dynamic-tool',
        toolName: 'plan-create',
        state: 'output-available',
        output: { plan: snapshot(1, ['pending']).plan, change: { op: 'create' } },
      }),
      part({ type: 'data-plan', id: 'plan-7', data: { plan: snapshot(1, ['pending']).plan } }),
    ])

    expect(messagePlan?.current.plan.revision).toBe(1)
    expect(messagePlan?.history).toHaveLength(0)
    expect(messagePlan?.current.change).toEqual({ op: 'create' })
  })

  it('出参还没回来 / 不是计划时不出卡片（原始工具卡照旧显示）', () => {
    expect(
      collectMessagePlan([
        part({ type: 'dynamic-tool', toolName: 'plan-create', state: 'input-available' }),
        part({ type: 'dynamic-tool', toolName: 'list-todos', state: 'output-available', output: { total: 2 } }),
      ]),
    ).toBeNull()
  })

  /**
   * 实时流的**真实 part 形态**（实测：服务端下发的片段带 `dynamic:false`，AI SDK 于是按静态工具
   * 建 part —— `type` 是 `tool-<工具名>`，**没有 `toolName` 字段**）。
   * 只认 `dynamic-tool` 会让计划在实时阶段永远收集不到，用户看到的就是"任务清单不显示"。
   */
  it('实时形态二（`tool-<名字>`，无 toolName 字段）也要能收集到，且吸收原工具卡', () => {
    const messagePlan = collectMessagePlan([
      part({ type: 'text' }),
      part({
        type: 'tool-plan-complete',
        state: 'output-available',
        output: { goal: '整理待办周报', revision: 5, tasks: [{ id: 't1', title: '取数', status: 'done' }] },
      }),
    ])

    expect(messagePlan).not.toBeNull()
    expect(messagePlan?.current.plan.revision).toBe(5)
    expect(messagePlan?.current.plan.tasks).toHaveLength(1)
    expect(messagePlan?.current.plan.tasks[0]).toMatchObject({ id: 't1', title: '取数', status: 'done' })
    expect(messagePlan?.history).toHaveLength(0)
    expect(messagePlan?.consumed).toEqual([1])
  })

  it('`tool-` 前缀但不是计划工具的照旧不认（不误吞普通工具卡）', () => {
    expect(
      collectMessagePlan([
        part({ type: 'tool-run-command', state: 'output-available', output: { ok: true } }),
        part({ type: 'tool-plan-create', state: 'input-available' }),
      ]),
    ).toBeNull()
  })

  it('历史：同一版既有工具出参又有 `data-plan` 时，**两份来源都被吸收**（不重复渲染原始卡）', () => {
    const plan = {
      goal: '整理待办周报',
      revision: 2,
      tasks: [{ id: 't1', title: '取数', status: 'pending' as PlanStatus }],
    }
    const messagePlan = collectMessagePlan([
      part({ type: 'tool-plan-update-task', state: 'output-available', output: plan }),
      part({ type: 'data-plan', id: 'plan-9', data: plan }),
      part({ type: 'text' }),
    ])

    expect(messagePlan?.current.plan.revision).toBe(2)
    expect(messagePlan?.history).toHaveLength(0)
    expect(messagePlan?.consumed).toEqual([0, 1])
  })
})

describe('describeChange', () => {
  const plan: Plan = {
    goal: '整理待办周报',
    revision: 2,
    tasks: [{ id: 't2', title: '写周报', status: 'in_progress' }],
  }

  it('按 op 拼出一行中文（含 revision 无关的关键字段）', () => {
    expect(describeChange({ op: 'update-task', taskId: 't2', status: 'done' }, plan)).toBe(
      '把 t2 标记为已完成',
    )
    expect(describeChange({ op: 'create' }, plan)).toBe('新建计划（共 1 项）')
    expect(describeChange({ op: 'replan' }, plan)).toBe('重新规划（共 1 项）')
    expect(describeChange(undefined, plan)).toBeUndefined()
  })

  it('未知 op 兜底展示 op 与可读字段，不吞信息', () => {
    expect(describeChange({ op: 'reorder', taskId: 't2', index: 1 }, plan)).toBe('reorder（taskId=t2，index=1）')
  })
})

describe('PlanPanel', () => {
  it('渲染目标 / 进度 / 任务（含备注）/ 变更摘要 / 变更历史', () => {
    const html = renderToStaticMarkup(
      createElement(PlanPanel, {
        plan: {
          goal: '整理待办周报',
          revision: 3,
          tasks: [
            { id: 't1', title: '取数', status: 'done', note: '来自 list-todos' },
            { id: 't2', title: '写周报', status: 'in_progress' },
            { id: 't3', title: '发出去', status: 'blocked' },
          ],
        },
        change: { op: 'update-task', taskId: 't2', status: 'in_progress' },
        history: [{ plan: { goal: '整理待办周报', revision: 1, tasks: [] }, change: { op: 'create' } }],
      }),
    )

    expect(html).toContain('整理待办周报')
    expect(html).toContain('已完成 1 / 共 3')
    expect(html).toContain('第 3 版')
    expect(html).toContain('取数')
    expect(html).toContain('来自 list-todos')
    expect(html).toContain('刚刚：把 t2 标记为进行中')
    expect(html).toContain('变更历史（1）')
  })
})

describe('conversationPlanOf（右栏「任务」tab 的数据来源）', () => {
  const message = (...parts: PlanSourcePart[]) => ({ parts })

  it('没有任何计划 → null（右栏给空态，不画空壳卡片）', () => {
    expect(conversationPlanOf([message(part({ type: 'text' }))])).toBeNull()
    expect(conversationPlanOf([])).toBeNull()
  })

  it('跨消息取**最高版本**当当前计划，更早的版本进历史并按版本升序', () => {
    const conversation = conversationPlanOf([
      // 第 1 轮：建清单（revision 1）
      message(
        part({
          type: 'tool-plan-create',
          state: 'output-available',
          output: snapshot(1, ['pending', 'pending']),
        }),
      ),
      // 第 3 轮：改状态（revision 3）
      message(
        part({
          type: 'dynamic-tool',
          toolName: 'plan-complete',
          state: 'output-available',
          output: snapshot(3, ['done', 'in_progress']),
        }),
      ),
    ])

    expect(conversation?.current.plan.revision).toBe(3)
    expect(conversation?.history.map((item) => item.plan.revision)).toEqual([1])
  })

  it('同一版本在多条消息里重复出现（`data-plan` + 工具出参）只算一次', () => {
    const conversation = conversationPlanOf([
      message(
        part({ type: 'data-plan', id: 'plan-5', data: snapshot(5, ['done']) }),
        part({ type: 'tool-plan-reorder', state: 'output-available', output: snapshot(5, ['done']) }),
      ),
      message(part({ type: 'data-plan', id: 'plan-6', data: snapshot(5, ['done']) })),
    ])

    expect(conversation?.current.plan.revision).toBe(5)
    expect(conversation?.history).toHaveLength(0)
  })

  it('全是无版本号的旧协议数据（revision 0）也能取到最后一条', () => {
    const conversation = conversationPlanOf([
      message(part({ type: 'data-plan', id: 'plan-1', data: { goal: '旧 A', steps: [] } })),
      message(part({ type: 'data-plan', id: 'plan-2', data: { goal: '旧 B', steps: [] } })),
    ])

    expect(conversation?.current.plan.goal).toBe('旧 B')
    expect(conversation?.current.plan.revision).toBe(0)
  })
})

describe('PlanSummaryCard（消息里的紧凑卡）', () => {
  const plan: Plan = {
    goal: '整理待办周报',
    revision: 4,
    tasks: [
      { id: 't1', title: '取数', status: 'done' },
      { id: 't2', title: '写周报', status: 'in_progress' },
      { id: 't3', title: '发出去', status: 'blocked' },
    ],
  }

  it('只给"做到哪了"这一眼：目标 + 进度 + 正在做的那一项 + 受阻数', () => {
    const html = renderToStaticMarkup(createElement(PlanSummaryCard, { plan }))

    expect(html).toContain('整理待办周报')
    expect(html).toContain('已完成 1 / 共 3')
    expect(html).toContain('正在做：写周报')
    expect(html).toContain('1 项受阻')
    // 完整清单（含备注与变更历史）在右栏，紧凑卡里不重复铺任务行
    expect(html).not.toContain('取数</')
  })

  it('没有 `onOpen` 时不渲染入口按钮（子 run 里复用同一张卡时不该有跳转）', () => {
    const withoutEntry = renderToStaticMarkup(createElement(PlanSummaryCard, { plan }))
    const withEntry = renderToStaticMarkup(
      createElement(PlanSummaryCard, { plan, onOpen: () => undefined }),
    )

    expect(withoutEntry).not.toContain('查看清单')
    expect(withEntry).toContain('查看清单')
  })

  it('没有进行中的任务时不占位那一行', () => {
    const html = renderToStaticMarkup(
      createElement(PlanSummaryCard, {
        plan: { ...plan, tasks: [{ id: 't1', title: '取数', status: 'done' }] },
      }),
    )

    expect(html).not.toContain('正在做：')
    expect(html).not.toContain('受阻')
  })
})
