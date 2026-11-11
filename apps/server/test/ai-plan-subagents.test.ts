import 'dotenv/config'
import { CommandRunner, Db, setAuditUserProvider } from '@repo/kits'
import { RunStatus, TimelineKind, TimelineRole } from '@repo/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConversationEntity } from '../src/database/entities/conversation-entity.js'
import { RunEntity } from '../src/database/entities/run-entity.js'
import { TimelineEntity } from '../src/database/entities/timeline-entity.js'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from '../src/modules/ai/agents/index.js'
import { createMastra } from '../src/modules/ai/mastra/ai.mastra.js'
import { createAgentRegistry } from '../src/modules/ai/agents/registry.js'
import type { AgentSpec } from '../src/modules/ai/agents/types.js'
import { type AgentRuntimeEnvelope, type RuntimeModel } from '../src/modules/ai/core/envelope.js'
import { PlannerStore, PlannerTools, type PlanOutput } from '../src/modules/ai/tools/planner/index.js'
import { RunSubAgentTool } from '../src/modules/ai/tools/subagent.tool.js'
import { BashTool } from '../src/modules/ai/tools/bash.tool.js'
import { FileTools } from '../src/modules/ai/files/file.tools.js'
import { WebTools } from '../src/modules/ai/tools/web.tools.js'
import { createPromptEngine } from '../src/modules/ai/core/prompts/index.js'
import { AgentTitleService } from '../src/modules/ai/runtime/title.service.js'
import { SkillLoader } from '../src/modules/ai/core/skills/index.js'
import { toMastraSkills } from '../src/modules/ai/mastra/skill.adapter.js'
import { toMastraTools } from '../src/modules/ai/mastra/tool.adapter.js'
import { ReadToolResultTool } from '../src/modules/ai/tools/read-tool-result.tool.js'
import { buildToolSpecs, type AgentToolGroup } from '../src/modules/ai/core/tools/tool.class.js'
import { ToolGateway } from '../src/modules/ai/core/tools/tool.gateway.js'
import { ToolRegistry } from '../src/modules/ai/core/tools/tool.registry.js'
import { TOOL_KEYS } from '../src/modules/ai/core/tools/tool-keys.js'
import { toPlanPayload } from '../src/modules/ai/runtime/plan.protocol.js'
import { AgentChatService } from '../src/modules/ai/runtime/chat.service.js'
import { AgentRunner } from '../src/modules/ai/runtime/agent-runner.js'
import { AgentConversationService } from '../src/modules/ai/runtime/conversation.service.js'
import { AgentRunService } from '../src/modules/ai/runtime/run.service.js'
import { ConversationRepository } from '../src/modules/ai/runtime/conversation.repository.js'
import { ContextService } from '../src/modules/ai/runtime/context.service.js'
import { RunRepository } from '../src/modules/ai/runtime/run.repository.js'
import { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'
import { buildToolStackDeps } from './helpers/ai-tool-stack.js'
import { stubAttachments } from './helpers/attachments.js'
import {
  MOCK_CHILD_TEXT,
  MOCK_COMMAND_TOOL,
  MOCK_DELEGATE_MARKER,
  MOCK_DELEGATE_TOOL,
  MOCK_PLAN_COMPLETE_TOOL,
  MOCK_PLAN_CREATE_TOOL,
  MOCK_PLAN_DELETE_TOOL,
  MOCK_PLAN_INITIAL,
  MOCK_PLAN_OVERWRITE_ADD,
  MOCK_PLAN_OVERWRITE_FINAL,
  MOCK_PLAN_OVERWRITE_MARKER,
  MOCK_PLAN_REACT_FINAL,
  MOCK_PLAN_REACT_FIRST,
  MOCK_PLAN_REACT_MARKER,
  MOCK_PLAN_REACT_SECOND,
  MOCK_PLAN_REORDER_TOOL,
  MOCK_REASON,
  MOCK_SUBAGENT_NAME,
  MOCK_SUBAGENT_PROMPT,
  MOCK_SUBAGENT_TASK,
  type MockModelServer,
  startMockModelServer,
} from './helpers/mock-model-server.js'

/**
 * 规划能力（任务清单）与**动态子 agent**（设计文档 §3.14）：
 * - 工具组是**唯一来源**：`PlannerTools`（组内四个 `@ToolDecl` 方法）/ `BashTool` /
 *   `RunSubAgentTool` / `ReadToolResultTool` 各自用 `@ToolGroup` + `@ToolDecl` 声明，
 *   `ToolRegistry` 对每个组 `buildToolSpecs()` 拍平成一张表（一个组 1..n 个工具）；
 * - 规划：现在是**一组四个增量工具**（create / reorder / complete / delete）——一次只表达一件事，
 *   但**出参永远是完整清单快照**，所以协议仍然只有一种形状（「当前计划」= 最后一条 `plan` 事件）；
 *   工具**自己不写库**，由运行时落成时间线的 `plan` 事件（append-only）；
 * - 子 agent：**运行期由工具创建**（提示词由主 agent 现写）、工具面 = 全部 − 委派类 − `child: deny`、
 *   一切明细入库（独立 run + 完整时间线）、消耗汇总进父、同一 toolCallId 幂等复用。
 */

/** 规划工具组的四个 key（与 `PlannerTools` 里四个 `@ToolDecl` 方法的登记顺序一致） */
const PLAN_KEYS = [
  TOOL_KEYS.planCreate,
  TOOL_KEYS.planReorder,
  TOOL_KEYS.planComplete,
  TOOL_KEYS.planDelete,
] as const

const USER = 'user_ai_plan'
const silentLogger = {
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

/** 纯装配断言用的替身：不读时间线（"从时间线读当前计划"由专门用例覆盖） */
const stubTimeline = { latestPlan: async () => null } as never

/** 纯装配断言用的工具栈依赖（不碰 DB / Redis / 模型） */
const deps = buildToolStackDeps()
const gateway = new ToolGateway(deps.config, silentLogger, [], deps.clock)

/** 纯装配断言用的规划工具组（四个工具共享一个 store）；与 `ai.module.ts` 的装配口径一致 */
const buildPlannerGroups = (timeline: unknown = stubTimeline): AgentToolGroup[] => [
  new PlannerTools(new PlannerStore(timeline as never)),
]

/** 工具池 = 传入的工具组数组（默认只放规划组）；与 `ai.module.ts` 的装配口径一致 */
const buildRegistry = (groups: AgentToolGroup[] = buildPlannerGroups()): ToolRegistry =>
  new ToolRegistry(groups, gateway, deps.config)

/** 测试用的 agent 声明（只关心工具授权，故其余字段按空补上） */
const spec = (partial: Partial<AgentSpec> & { key: string }): AgentSpec => ({
  name: partial.key,
  description: partial.key,
  tools: [],
  skills: [],
  prompt: { template: 'assistant' },
  ...partial,
})

describe('规划能力（规划工具组 + plan 事件）', () => {
  it('规划工具组交出四个规划声明（增量操作、不是委派类、只给主 agent）', () => {
    const specs = buildToolSpecs(new PlannerTools(new PlannerStore(stubTimeline)))
    expect(specs.map((item) => item.key)).toEqual([...PLAN_KEYS])
    // 声明的工具名就是 mock 认得的工具名（mock 只能发它"认得"的工具）
    expect(specs.map((item) => item.key)).toEqual([
      MOCK_PLAN_CREATE_TOOL,
      MOCK_PLAN_REORDER_TOOL,
      MOCK_PLAN_COMPLETE_TOOL,
      MOCK_PLAN_DELETE_TOOL,
    ])
    for (const item of specs) {
      // 规划不是委派类工具（`delegation` 未标记）；但都是 `child: 'deny'`：
      // 清单归属发起这一轮的主 agent（也顺手堵住"子 agent 的清单顶掉父的当前计划"）
      expect(item.delegation).toBeUndefined()
      expect(item.child).toBe('deny')
      // 说明是"能给模型看"的一段话（什么时候用 / 什么时候不用 / 纪律）
      expect(item.description.length).toBeGreaterThan(60)
    }
  })

  it('ToolRegistry：工具池不能为空；重复 key 启动期报错', () => {
    const registry = buildRegistry()
    expect(registry.keys()).toEqual([...PLAN_KEYS])

    // 工具池不能为空 → 装配错误（宁可起不来，也不要静默少能力）
    expect(() => buildRegistry([])).toThrow(/工具池不能为空/)

    // 同一个 key 由两个组提供 → 装配错误（宁可起不来，也不要静默覆盖）
    expect(() => buildRegistry([...buildPlannerGroups(), ...buildPlannerGroups()])).toThrow(
      /工具 key 重复/,
    )
  })

  it('四个规划工具的输出都会被认成计划（别的工具不会误伤，形状不对也不认）', () => {
    const output = { ...MOCK_PLAN_INITIAL, revision: 1, summary: '共 2 项' }
    expect(toPlanPayload(MOCK_DELEGATE_TOOL, output)).toBeNull()
    // 四个 key 都在 `PLAN_TOOL_KEYS` 里登记过：任意一个的出参都落 `plan` 事件
    for (const key of PLAN_KEYS) {
      expect(toPlanPayload(key, output)).toMatchObject({
        goal: MOCK_PLAN_INITIAL.goal,
        revision: 1,
      })
    }
    // 缺 revision / tasks 形状不对 → 不认（半真半假的计划不如没有）
    expect(toPlanPayload(TOOL_KEYS.planCreate, { goal: 'g', tasks: [] })).toBeNull()
    expect(toPlanPayload(TOOL_KEYS.planCreate, { goal: 'g', revision: 1 })).toBeNull()
    // 状态必须落在三态里
    expect(
      toPlanPayload(TOOL_KEYS.planCreate, {
        goal: 'g',
        revision: 1,
        tasks: [{ id: 't1', title: 'x', status: 'blocked' }],
      }),
    ).toBeNull()
  })

  it('① 首次创建：模型调 plan-create → plan 事件（payload 含 goal/tasks/revision=1）', async () => {
    const { chat, conversations } = await stack()
    const result = await chat.chat(USER, { message: '帮我把待办整理成周报' })
    expect(result.status).toBe(RunStatus.Succeeded)
    expect(result.toolCallCount).toBe(1)

    const plans = await planEvents(result.conversationId)
    expect(plans).toHaveLength(1)
    // payload 就是那一版清单本身（goal / revision / tasks），不夹带摘要
    expect(plans[0].payload).toEqual({
      goal: MOCK_PLAN_INITIAL.goal,
      revision: 1,
      tasks: MOCK_PLAN_INITIAL.tasks,
    })
    // 计划事件紧跟在工具结果之后（seq 连续，前端按顺序渲染）
    const page = await timelinesPage(result.conversationId)
    const toolResult = page.items.find((item) => item.kind === TimelineKind.ToolResult)
    expect(plans[0].seq).toBeGreaterThan(toolResult!.seq)

    const conversation = await conversations.detail(USER, { conversationId: result.conversationId })
    expect(conversation.id).toBe(result.conversationId)
  }, 30_000)

  it('② 增量序列：complete t1 → create 追加 t3 → delete t2；每步落一条 plan 事件且 revision 递增', async () => {
    const { chat } = await stack()
    const first = await chat.chat(USER, { message: '把待办整理成周报' })
    const second = await chat.chat(USER, {
      conversationId: first.conversationId,
      message: `按新口径再来一版 ${MOCK_PLAN_OVERWRITE_MARKER}`,
    })
    expect(second.status).toBe(RunStatus.Succeeded)
    // 一次只表达一件事：第二轮是**三次增量调用**（不是重写整份清单）
    expect(second.toolCallCount).toBe(3)

    const page = await timelinesPage(first.conversationId)
    const calls = page.items.filter(
      (item) => item.kind === TimelineKind.ToolCall && item.runId === second.runId,
    )
    expect(calls.map((item) => item.toolKey)).toEqual([
      MOCK_PLAN_COMPLETE_TOOL,
      MOCK_PLAN_CREATE_TOOL,
      MOCK_PLAN_DELETE_TOOL,
    ])
    // 第 2 步是**追加**：goal 省略（沿用当前目标），入参里只有新增的 t3（+ 引擎注入的必填 reason）
    expect(calls[1].payload?.input).toEqual({ ...MOCK_PLAN_OVERWRITE_ADD, reason: MOCK_REASON })

    const plans = await planEvents(first.conversationId)
    // 每一步都落一条 plan 事件（首建 + 第二轮三步），revision 每成功变更 +1
    expect(plans.map((item) => (item.payload as { revision: number }).revision)).toEqual([1, 2, 3, 4])
    // 中间那一步（create 追加）的出参是**完整快照**：t1 已完成、t2 还在、t3 刚加进来
    expect(plans[2].payload).toMatchObject({
      revision: 3,
      tasks: [
        { id: 't1', status: 'completed' },
        { id: 't2', status: 'pending' },
        { id: 't3', status: 'pending' },
      ],
    })
    // 「当前计划」= 最后一条：t1 completed、t3 新增、t2 已删除、目标沿用
    expect(plans[3].payload).toEqual(MOCK_PLAN_OVERWRITE_FINAL)

    // 工具出参里能看到这一步改了哪几项（模型据此确认自己的改动生效了）
    const results = page.items.filter(
      (item) => item.kind === TimelineKind.ToolResult && item.runId === second.runId,
    )
    expect(results.map((item) => item.toolKey)).toEqual([
      MOCK_PLAN_COMPLETE_TOOL,
      MOCK_PLAN_CREATE_TOOL,
      MOCK_PLAN_DELETE_TOOL,
    ])
    expect((results[0].payload?.output as PlanOutput).summary).toContain('t1 in_progress→completed')
    expect((results[1].payload?.output as PlanOutput).summary).toContain('新增 t3')
    expect((results[2].payload?.output as PlanOutput).summary).toContain('删除 t2')
  }, 30_000)

  it('③ 同一轮内串行读改写：第二次调用读到第一次新增的 r2（revision=1 → 2）', async () => {
    const { chat } = await stack()
    // 全新会话：这一轮本身就是首次创建 —— 第一次是 revision=1，第二次必须是 2
    const result = await chat.chat(USER, { message: `一口气把清单写两版 ${MOCK_PLAN_REACT_MARKER}` })
    expect(result.status).toBe(RunStatus.Succeeded)
    // 一轮里真的调了两次规划工具（plan-create → plan-complete）
    expect(result.toolCallCount).toBe(2)

    const page = await timelinesPage(result.conversationId)
    const runPlans = page.items.filter(
      (item) => item.kind === TimelineKind.Plan && item.runId === result.runId,
    )
    // 运行时在**整轮结束后**才落库：此刻时间线上一条 `plan` 事件都没有。
    // 第二次能算出 revision=2（而不是又算一次 1），只能是因为它读到了
    // 第一次在本轮内存里留下的结果 —— 这就是"react 循环里能调整清单"的硬证明。
    expect(runPlans.map((item) => (item.payload as { revision: number }).revision)).toEqual([1, 2])
    expect(runPlans[1].payload).toEqual(MOCK_PLAN_REACT_FINAL)

    const calls = page.items.filter(
      (item) => item.kind === TimelineKind.ToolCall && item.runId === result.runId,
    )
    expect(calls.map((item) => item.toolKey)).toEqual([
      MOCK_PLAN_CREATE_TOOL,
      MOCK_PLAN_COMPLETE_TOOL,
    ])
    expect(calls[0].payload?.input).toEqual({ ...MOCK_PLAN_REACT_FIRST, reason: MOCK_REASON })
    // 第二次调用的入参里**带着第一次新增的 r2**（用 ids 引用它），并把 [react-2] 写进它的备注
    expect(calls[1].payload?.input).toEqual({ ...MOCK_PLAN_REACT_SECOND, reason: MOCK_REASON })
  }, 30_000)

  it('④ 同时多个 in_progress：不阻断提交，但在出参里给出纪律提示', async () => {
    const { toolRegistry, timelines, conversations, runs } = await stack()
    const conversation = await conversations.create(USER, {})
    const run = await runs.create({
      conversationId: conversation.id,
      agentKey: DEFAULT_AGENT_KEY,
      status: RunStatus.Running,
    })

    const output = await executePlanTool(
      toolRegistry,
      TOOL_KEYS.planCreate,
      {
        goal: '并行推进两件事',
        tasks: [
          { id: 'a', title: '写方案', status: 'in_progress' },
          { id: 'b', title: '拉数据', status: 'in_progress' },
        ],
      },
      runtimeEnvelope(conversation.id, run.id),
    )

    expect(output.revision).toBe(1)
    expect(output.tasks).toHaveLength(2)
    expect(output.summary).toContain('共 2 项')
    expect(output.warnings?.[0]).toContain('同时只应有一个进行中')

    // 工具**自己不写库**：落 `plan` 事件是运行时的职责（这里没有运行时，时间线必须还是空的）
    expect(await timelines.latestPlan(conversation.id)).toBeNull()
    await runs.finish(run.id, { status: RunStatus.Canceled })
  }, 30_000)

  it('⑤ 当前计划从时间线读 + create 是追加：沿用未给的目标、原任务保留、revision=2', async () => {
    const { toolRegistry, timelines, conversations, runs } = await stack()
    const conversation = await conversations.create(USER, {})
    const run = await runs.create({
      conversationId: conversation.id,
      agentKey: DEFAULT_AGENT_KEY,
      status: RunStatus.Running,
    })
    // 种一条上一轮的 `plan` 事件（模拟"会话里已经有一版计划"）
    await timelines.append({
      conversationId: conversation.id,
      runId: run.id,
      role: TimelineRole.Assistant,
      kind: TimelineKind.Plan,
      payload: {
        goal: '把待办整理成周报',
        revision: 1,
        tasks: [{ id: 'old1', title: '取最近的待办', status: 'completed' }],
      },
    })
    // 用一个**新的 runId**（= 新的一轮，本轮内存里没有活计划）提交
    const output = await executePlanTool(
      toolRegistry,
      TOOL_KEYS.planCreate,
      { tasks: [{ id: 'n1', title: '按主题分组', status: 'in_progress' }] },
      runtimeEnvelope(conversation.id, `${run.id}_next`),
    )

    expect(output.revision).toBe(2)
    expect(output.goal).toBe('把待办整理成周报') // goal 省略 → 沿用时间线里的目标
    // 追加语义：old1 **原样保留**（不再有"没出现即删除"这回事）
    expect(output.tasks.map((task) => task.id)).toEqual(['old1', 'n1'])
    expect(output.summary).toContain('新增 n1')

    await runs.finish(run.id, { status: RunStatus.Canceled })
  }, 30_000)

  it('⑥ plan-reorder：order 必须与全部 id 一一对应，updates 就地改标题 / 标 in_progress', async () => {
    const { toolRegistry, timelines, conversations, runs } = await stack()
    const conversation = await conversations.create(USER, {})
    const run = await runs.create({
      conversationId: conversation.id,
      agentKey: DEFAULT_AGENT_KEY,
      status: RunStatus.Running,
    })
    await timelines.append({
      conversationId: conversation.id,
      runId: run.id,
      role: TimelineRole.Assistant,
      kind: TimelineKind.Plan,
      payload: {
        goal: '把待办整理成周报',
        revision: 1,
        tasks: [
          { id: 'a', title: '写方案', status: 'pending' },
          { id: 'b', title: '拉数据', status: 'pending' },
        ],
      },
    })
    const envelope = runtimeEnvelope(conversation.id, `${run.id}_reorder`)

    // order 少了 / 多了 / 有重复 → 一律拒绝（并把当前清单列出来）
    await expect(
      executePlanTool(toolRegistry, TOOL_KEYS.planReorder, { order: ['a'] }, envelope),
    ).rejects.toThrow(/一一对应/)
    await expect(
      executePlanTool(toolRegistry, TOOL_KEYS.planReorder, { order: ['a', 'b', 'c'] }, envelope),
    ).rejects.toThrow(/一一对应/)
    await expect(
      executePlanTool(toolRegistry, TOOL_KEYS.planReorder, { order: ['a', 'a'] }, envelope),
    ).rejects.toThrow(/一一对应/)
    // updates 未知 id → 拒绝
    await expect(
      executePlanTool(toolRegistry, TOOL_KEYS.planReorder, { updates: [{ id: 'zzz' }] }, envelope),
    ).rejects.toThrow(/任务不存在/)

    // 合法：一次调用同时重排 + 改标题 + 标 in_progress（失败的那几次没有污染内存）
    const output = await executePlanTool(
      toolRegistry,
      TOOL_KEYS.planReorder,
      {
        order: ['b', 'a'],
        updates: [
          { id: 'b', status: 'in_progress' },
          { id: 'a', title: '写方案（v2）' },
        ],
      },
      envelope,
    )
    expect(output.revision).toBe(2)
    expect(output.tasks.map((task) => [task.id, task.status])).toEqual([
      ['b', 'in_progress'],
      ['a', 'pending'],
    ])
    expect(output.tasks[1].title).toBe('写方案（v2）')
    expect(output.summary).toContain('顺序已重排')
    expect(output.summary).toContain('b pending→in_progress')
    expect(output.summary).toContain('a 标题已更新')

    await runs.finish(run.id, { status: RunStatus.Canceled })
  }, 30_000)

  it('⑦ plan-complete：批量完成 + note 写进备注；重复标同一批是幂等的', async () => {
    const { toolRegistry, timelines, conversations, runs } = await stack()
    const conversation = await conversations.create(USER, {})
    const run = await runs.create({
      conversationId: conversation.id,
      agentKey: DEFAULT_AGENT_KEY,
      status: RunStatus.Running,
    })
    await timelines.append({
      conversationId: conversation.id,
      runId: run.id,
      role: TimelineRole.Assistant,
      kind: TimelineKind.Plan,
      payload: {
        goal: '把待办整理成周报',
        revision: 1,
        tasks: [
          { id: 'c1', title: '起草', status: 'in_progress' },
          { id: 'c2', title: '校对', status: 'pending' },
          { id: 'c3', title: '发布', status: 'pending' },
        ],
      },
    })
    const envelope = runtimeEnvelope(conversation.id, `${run.id}_complete`)

    const output = await executePlanTool(
      toolRegistry,
      TOOL_KEYS.planComplete,
      { ids: ['c1', 'c2'], note: '结论：已核对' },
      envelope,
    )
    expect(output.revision).toBe(2)
    expect(output.tasks.map((task) => task.status)).toEqual([
      'completed',
      'completed',
      'pending',
    ])
    expect(output.tasks[0].note).toBe('结论：已核对')
    expect(output.tasks[2].note).toBeUndefined()

    // 幂等：已经完成的再标一次不报错，摘要说明"本来就是已完成"
    const again = await executePlanTool(
      toolRegistry,
      TOOL_KEYS.planComplete,
      { ids: ['c1'] },
      envelope,
    )
    expect(again.revision).toBe(3)
    expect(again.summary).toContain('本来就是已完成')

    // 未知 id → 拒绝，并把当前清单列出来
    await expect(
      executePlanTool(toolRegistry, TOOL_KEYS.planComplete, { ids: ['zzz'] }, envelope),
    ).rejects.toThrow(/任务不存在：zzz/)

    await runs.finish(run.id, { status: RunStatus.Canceled })
  }, 30_000)

  it('⑧ plan-delete：批量删除、允许删空（目标保留）、未知 id 拒绝', async () => {
    const { toolRegistry, timelines, conversations, runs } = await stack()
    const conversation = await conversations.create(USER, {})
    const run = await runs.create({
      conversationId: conversation.id,
      agentKey: DEFAULT_AGENT_KEY,
      status: RunStatus.Running,
    })
    await timelines.append({
      conversationId: conversation.id,
      runId: run.id,
      role: TimelineRole.Assistant,
      kind: TimelineKind.Plan,
      payload: {
        goal: '把待办整理成周报',
        revision: 1,
        tasks: [
          { id: 'd1', title: '取待办', status: 'pending' },
          { id: 'd2', title: '分组', status: 'pending' },
          { id: 'd3', title: '写周报', status: 'pending' },
        ],
      },
    })
    const envelope = runtimeEnvelope(conversation.id, `${run.id}_delete`)

    const output = await executePlanTool(toolRegistry, TOOL_KEYS.planDelete, { ids: ['d2'] }, envelope)
    expect(output.revision).toBe(2)
    expect(output.tasks.map((task) => task.id)).toEqual(['d1', 'd3'])
    expect(output.summary).toContain('删除 d2')

    // 未知 id（含刚被删掉的那个）→ 拒绝
    await expect(
      executePlanTool(toolRegistry, TOOL_KEYS.planDelete, { ids: ['d2'] }, envelope),
    ).rejects.toThrow(/任务不存在：d2/)

    // 删空是允许的：任务清空但目标保留
    const emptied = await executePlanTool(
      toolRegistry,
      TOOL_KEYS.planDelete,
      { ids: ['d1', 'd3'] },
      envelope,
    )
    expect(emptied.tasks).toEqual([])
    expect(emptied.goal).toBe('把待办整理成周报')

    await runs.finish(run.id, { status: RunStatus.Canceled })
  }, 30_000)

  it('入参校验：首次创建必须给 goal；同一批里 id 重复要报错', async () => {
    const { toolRegistry, conversations, runs } = await stack()
    const conversation = await conversations.create(USER, {})
    const run = await runs.create({
      conversationId: conversation.id,
      agentKey: DEFAULT_AGENT_KEY,
      status: RunStatus.Running,
    })

    // 这个会话里**还没有任何计划** → 省略 goal 无从沿用，必须报错
    await expect(
      executePlanTool(
        toolRegistry,
        TOOL_KEYS.planCreate,
        { tasks: [{ title: '没有目标' }] },
        runtimeEnvelope(conversation.id, `${run.id}_blank`),
      ),
    ).rejects.toThrow(/必须给 goal/)

    // 同一批里 id 重复 → 拒绝（否则"改状态"就会变成掷骰子）
    await expect(
      executePlanTool(
        toolRegistry,
        TOOL_KEYS.planCreate,
        {
          goal: 'x',
          tasks: [
            { id: 'dup', title: 'a', status: 'pending' },
            { id: 'dup', title: 'b', status: 'pending' },
          ],
        },
        runtimeEnvelope(conversation.id, `${run.id}_dup`),
      ),
    ).rejects.toThrow(/id 重复/)

    await runs.finish(run.id, { status: RunStatus.Canceled })
  }, 30_000)
})

describe('子 agent（core bean + 运行期动态创建）', () => {
  it('工具面：子 agent = 全部 − 委派类 − child:deny（于是它不能再造子 agent）', () => {
    const registry = buildRegistry([
      ...buildPlannerGroups(),
      new RunSubAgentTool(
        { runSubAgent: async () => ({ status: 'succeeded' }) } as never,
        silentLogger,
      ),
      new BashTool(new CommandRunner(), silentLogger),
      new WebTools(silentLogger as never),
      new FileTools({} as never, { enabled: true } as never),
    ])
    expect(registry.delegationKeys()).toEqual([MOCK_DELEGATE_TOOL])
    const childKeys = [...registry.childToolbox().keys()]
    // 非委派类工具照给子 agent（如 bash）
    expect(childKeys).toContain(TOOL_KEYS.bash)
    // 关键：子 agent 拿不到委派工具 → 递归在**能力上**不可能，不靠提示词自律
    expect(childKeys).not.toContain(MOCK_DELEGATE_TOOL)
    // 文件工具给子 agent：子助手可以读工作区、写自己的交付文件
    for (const key of [
      TOOL_KEYS.fileList,
      TOOL_KEYS.fileDownload,
      TOOL_KEYS.readFile,
      TOOL_KEYS.fileSearch,
      TOOL_KEYS.workspaceFiles,
      TOOL_KEYS.writeFile,
      TOOL_KEYS.replaceFile,
      TOOL_KEYS.appendFile,
      TOOL_KEYS.fileSubmit,
    ]) {
      expect(childKeys).toContain(key)
    }
    // `child: 'deny'` 的工具同样不给（四个规划工具都只给主 agent，子助手把结论交回即可）
    for (const key of PLAN_KEYS) expect(childKeys).not.toContain(key)
  })

  it('对外清单用 canSpawnSubAgents 表达能力（不再有静态子 agent 名单）', () => {
    const registry = createAgentRegistry(
      [
        spec({ key: 'a', tools: [TOOL_KEYS.planCreate, MOCK_DELEGATE_TOOL] }),
        spec({ key: 'b', tools: [TOOL_KEYS.planCreate] }),
      ],
      'a',
    )
    const list = registry.list()
    expect(list.agents.find((agent) => agent.key === 'a')?.canSpawnSubAgents).toBe(true)
    expect(list.agents.find((agent) => agent.key === 'b')?.canSpawnSubAgents).toBe(false)
  })

  it('Mastra 装配里不再有静态子 agent（`agents:{}` 已删除）', async () => {
    const toolRegistry = buildRegistry([
      ...buildPlannerGroups(),
      new RunSubAgentTool(
        { runSubAgent: async () => ({ status: 'succeeded' }) } as never,
        silentLogger,
      ),
      new BashTool(new CommandRunner(), silentLogger),
      new WebTools(silentLogger as never),
      new FileTools({} as never, { enabled: true } as never),
    ])
    const registry = createAgentRegistry(
      createAgentDefinitions(createPromptEngine(), toolRegistry),
      DEFAULT_AGENT_KEY,
    )
    const skillLoader = new SkillLoader(silentLogger)
    const mastra = await createMastra({
      resolveModel: () => ({ id: 'mock/mock-model', apiKey: 'k', url: 'http://127.0.0.1:1/v1' }),
      definitions: registry.all(),
      resolveTools: (keys) => toMastraTools(toolRegistry.toolbox(keys), silentLogger),
      resolveSkills: async (names) => toMastraSkills(await skillLoader.resolve(names)),
    })
    const assistant = mastra.getAgent(DEFAULT_AGENT_KEY)
    expect(Object.keys(await assistant.listAgents())).toEqual([])
    // 但它有 run-sub-agent 工具（挂载的工具，不再是执行期物化的 `agent-<key>`）
    expect(Object.keys(await assistant.listTools())).toContain(MOCK_DELEGATE_TOOL)
  }, 30_000)

  it('端到端：模型创建子助手 → 父子 run 各自入库，明细完整，消耗汇总进父', async () => {
    const { chat, timelines, runs } = await stack()
    const result = await chat.chat(USER, { message: `帮我统计一下 ${MOCK_DELEGATE_MARKER}` })
    expect(result.status).toBe(RunStatus.Succeeded)

    // ① 父 run：只有根 run 才算"一轮"，工具调用与结果都在父的时间线里
    const page = await timelines.list({ conversationId: result.conversationId, page: 1, size: 200 })
    const call = page.items.find(
      (item) => item.kind === TimelineKind.ToolCall && item.toolKey === MOCK_DELEGATE_TOOL,
    )
    expect(call).toBeDefined()
    // 入参完整落库：主 agent 现写的 system_prompt 与 task 一字不少
    expect(call?.payload?.input).toMatchObject({
      name: MOCK_SUBAGENT_NAME,
      system_prompt: MOCK_SUBAGENT_PROMPT,
      task: MOCK_SUBAGENT_TASK,
      // 引擎注入的必填 reason 也一并落库（设计 §5.18）
      reason: MOCK_REASON,
    })
    const output = page.items.find(
      (item) => item.kind === TimelineKind.ToolResult && item.toolKey === MOCK_DELEGATE_TOOL,
    )
    const outcome = output?.payload?.output as {
      subRunId: string
      status: string
      result: string
      stepCount: number
    }
    expect(outcome.status).toBe('succeeded')
    expect(outcome.result).toContain(MOCK_CHILD_TEXT)
    expect(outcome.stepCount).toBeGreaterThan(0)

    // ② 子 run：独立一行，父子列齐备（agent_key = sub:<name>）
    const child = await runs.findEntity(outcome.subRunId)
    expect(child).not.toBeNull()
    expect(child?.parentRunId).toBe(result.runId)
    expect(child?.depth).toBe(1)
    expect(child?.toolCallId).toBeTruthy()
    expect(child?.conversationId).toBe(result.conversationId)

    // ③ 子 run 的**动态提示词与任务全量入库**（"它为什么这么干"的唯一证据）
    const childDetail = await runs.listChildren(result.runId)
    expect(childDetail).toHaveLength(1)
    const snapshot = child?.requestSnapshot as Record<string, unknown>
    expect(snapshot).toMatchObject({
      kind: 'subagent',
      name: MOCK_SUBAGENT_NAME,
      systemPrompt: MOCK_SUBAGENT_PROMPT,
      task: MOCK_SUBAGENT_TASK,
    })

    // ④ 子 run 自己的明细：任务、工具调用、结论文本都在它名下（同一会话，可整棵树拉出来）
    const childRows = page.items.filter((item) => item.runId === outcome.subRunId)
    expect(childRows.some((item) => item.kind === TimelineKind.Text && item.role === 'user')).toBe(true)
    expect(childRows.some((item) => item.kind === TimelineKind.ToolCall)).toBe(true)
    expect(
      childRows.some(
        (item) =>
          item.kind === TimelineKind.Text &&
          item.role === 'assistant' &&
          JSON.stringify(item.payload).includes(MOCK_CHILD_TEXT),
      ),
    ).toBe(true)

    // ⑤ 消耗：父的合计**含子**，且子那一份仍留在自己 run 里（谁的活花多少都查得到）
    const parent = await runs.findEntity(result.runId)
    const parentUsage = parent?.usage as { totalTokens: number; subAgents: { totalTokens: number } }
    expect(parentUsage.subAgents.totalTokens).toBeGreaterThan(0)
    expect(parentUsage.totalTokens).toBeGreaterThan(parentUsage.subAgents.totalTokens)
    const childUsage = child?.usage as { totalTokens: number }
    expect(childUsage.totalTokens).toBe(parentUsage.subAgents.totalTokens)

    // ⑥ 轮数只数根 run（子 agent 不是一轮）
    const conversation = await runs.findActive(result.conversationId)
    expect(conversation).toBeNull()
  }, 30_000)

  it('子 agent 那一轮真的拿到了工具（模型请求里的 tools 不含委派工具）', async () => {
    const { chat } = await stack()
    const before = mock.requests.length
    const result = await chat.chat(USER, { message: `再来一次统计 ${MOCK_DELEGATE_MARKER}` })
    expect(result.status).toBe(RunStatus.Succeeded)

    // 子 agent 的请求：system 是主 agent 现写的提示词；tools 有运行时能力、没有 run-sub-agent
    // 子 agent 那一轮的特征：**系统消息就是主 agent 现写的那段提示词**
    // （不能用"请求里出现过这段文字"来找 —— 父后续那一轮的工具调用入参里也有它）
    const childRequest = mock.requests.slice(before).find((body) => {
      const messages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>
      const system = messages.find((message) => message.role === 'system')
      return typeof system?.content === 'string' && system.content.includes(MOCK_SUBAGENT_PROMPT)
    })
    expect(childRequest).toBeDefined()
    const toolNames = (childRequest?.tools as Array<{ function?: { name?: string } }>).map(
      (tool) => tool.function?.name,
    )
    // 工具面 = 全部 − 委派类 − child:deny：bash 在，run-sub-agent 与四个规划工具都不在
    // （规划工具都是 `child: 'deny'`：清单归属主 agent，子助手只把结论交回）
    expect(toolNames).toContain(MOCK_COMMAND_TOOL)
    for (const key of PLAN_KEYS) expect(toolNames).not.toContain(key)
    expect(toolNames).not.toContain(MOCK_DELEGATE_TOOL)
  }, 30_000)

  it('幂等：同一 toolCallId 重放 → 复用上次结论，不重跑也不重复扣费', async () => {
    const { chat, runs, conversations, runner, timelines } = await stack()
    const result = await chat.chat(USER, { message: `幂等验证 ${MOCK_DELEGATE_MARKER}` })
    const page = await timelines.list({ conversationId: result.conversationId, page: 1, size: 200 })
    const child = (await runs.listChildren(result.runId))[0]
    const conversation = await conversations.detail(USER, { conversationId: result.conversationId })

    const requestsBefore = mock.requests.length
    const outcome = await runner.runSubAgent({
      name: MOCK_SUBAGENT_NAME,
      systemPrompt: MOCK_SUBAGENT_PROMPT,
      task: MOCK_SUBAGENT_TASK,
      // **同一个 toolCallId**：崩溃恢复重放就是这个形态
      toolCallId: child.toolCallId!,
      envelope: runtimeEnvelope(conversation.id, result.runId),
    })

    expect(outcome.reused).toBe(true)
    expect(outcome.subRunId).toBe(child.id)
    expect(outcome.result).toContain(MOCK_CHILD_TEXT)
    // 没有新的模型请求（没重跑）、没有新的子 run（没重复扣费）
    expect(mock.requests.length).toBe(requestsBefore)
    expect(await runs.countChildren(result.runId)).toBe(1)
    expect(page.items.length).toBeGreaterThan(0)
  }, 30_000)

  it('审计视角：run/list 一次拿到根与子（带父子列），且越权访问被拒', async () => {
    const { chat, runService } = await stack()
    const result = await chat.chat(USER, { message: `审计验证 ${MOCK_DELEGATE_MARKER}` })

    const page = await runService.list(USER, {
      conversationId: result.conversationId,
      page: 1,
      size: 50,
    })
    // 一次问答 = 一个根 run + 一个子 run（子 agent 也在同一张表里）
    expect(page.total).toBe(2)
    const root = page.items.find((item) => item.parentRunId === null)
    const child = page.items.find((item) => item.parentRunId !== null)
    expect(root?.depth).toBe(0)
    expect(child?.depth).toBe(1)
    expect(child?.parentRunId).toBe(root?.id)
    // 子 run 的 agent_key 是 `sub:<name>`（不在 agent 注册表里，这是有意的）
    expect(child?.agentKey).toBe(`sub:${MOCK_SUBAGENT_NAME}`)
    // 详情：根 run 能看到自己的子 run；子 run 能看到"主 agent 现写的提示词"
    const rootDetail = await runService.detail(USER, { runId: root!.id })
    expect(rootDetail.children.map((item) => item.id)).toEqual([child!.id])
    expect(rootDetail.requestSnapshot).toBeTruthy()

    const childDetail = await runService.detail(USER, { runId: child!.id })
    expect(childDetail.parentRunId).toBe(root!.id)
    expect(childDetail.requestSnapshot).toMatchObject({
      kind: 'subagent',
      systemPrompt: MOCK_SUBAGENT_PROMPT,
      task: MOCK_SUBAGENT_TASK,
    })
    expect(childDetail.children).toEqual([])

    // 全程不删（审计证据）：只能软删会话，运行记录没有删除入口
    await expect(
      runService.list('user_别的用户', { conversationId: result.conversationId, page: 1, size: 50 }),
    ).rejects.toMatchObject({ code: expect.any(Number) })
    await expect(
      runService.detail('user_别的用户', { runId: child!.id }),
    ).rejects.toMatchObject({ code: expect.any(Number) })
  }, 30_000)

  it('配额与深度：不抛异常炸整轮，而是把原因作为工具结论交回模型', async () => {
    const { chat, runs, conversations, runner } = await stack()
    const result = await chat.chat(USER, { message: `配额验证 ${MOCK_DELEGATE_MARKER}` })
    const conversation = await conversations.detail(USER, { conversationId: result.conversationId })
    const base = {
      name: MOCK_SUBAGENT_NAME,
      systemPrompt: MOCK_SUBAGENT_PROMPT,
      task: MOCK_SUBAGENT_TASK,
      toolCallId: null,
      envelope: runtimeEnvelope(conversation.id, result.runId),
    }

    // 深度超限：拿一个"已经在第 1 层"的信封
    const deep = await runner.runSubAgent({
      ...base,
      envelope: { ...base.envelope, depth: 1 },
    })
    expect(deep.status).toBe('rejected')
    expect(deep.subRunId).toBeNull()
    expect(deep.reason).toMatch(/深度上限/)

    // 配额：这次问答里已经造过 1 个，上限设成 1 就再也造不出来
    expect(await runs.countChildren(result.runId)).toBe(1)
    const quota = await runner.runSubAgent(
      { ...base, envelope: { ...base.envelope, depth: 0 } },
    )
    expect(quota.status).toBe('rejected')
    expect(quota.reason).toMatch(/上限/)
  }, 30_000)
})

// ── 端到端用的栈（整份文件共享一个 Db：DataSource 名唯一，不能反复建） ──

let mock: MockModelServer
let db: Db
let stackPromise: Promise<{
  chat: AgentChatService
  conversations: AgentConversationService
  timelines: TimelineRepository
  runs: RunRepository
  runner: AgentRunner
  runService: AgentRunService
  toolRegistry: ToolRegistry
}> | null = null

const stack = async () => {
  stackPromise ??= buildStack()
  return stackPromise
}

/** 会话里的全部 `plan` 事件（按 seq 升序；「当前计划」= 最后一条） */
const planEvents = async (conversationId: string) => {
  const page = await timelinesPage(conversationId)
  return page.items.filter((item) => item.kind === TimelineKind.Plan)
}

const timelinesPage = async (conversationId: string) => {
  const { timelines } = await stack()
  return timelines.list({ conversationId, page: 1, size: 300 })
}

/** 测试用的**运行时模型**（直接执行工具 / 造信封时用；域内不验证选模型） */
const runtimeModel = (): RuntimeModel => ({
  id: 'model_mock',
  modelRef: 'mock/mock-model',
  modelKey: 'mock-model',
  displayName: 'Mock 模型',
  providerKind: 'openai-compatible',
  baseURL: mock.baseURL,
  apiKey: 'test-key',
  contextWindow: null,
})

/** 手工装配运行时信封（直接执行工具时用；域内只关心会话与 run） */
const runtimeEnvelope = (conversationId: string, parentRunId: string): AgentRuntimeEnvelope => ({
  conversationId,
  parentRunId,
  triggeredBy: USER,
  isAdmin: false,
  depth: 0,
  agentKey: DEFAULT_AGENT_KEY,
  rootAgentKey: DEFAULT_AGENT_KEY,
  model: runtimeModel(),
  childToolbox: new Map(),
  skills: [],
})

/**
 * 直接执行某个规划工具（绕过模型，走网关 → 执行体，验证工具本身的行为约定）。
 *
 * 网关把失败折成统一结论（`ok: false` + message），这里把 message 抛出来 —— 与
 * `rejects.toThrow(/必须给 goal/)` 这类断言语义一致，同时顺带覆盖了"拒绝是结论不是崩溃"这条链路。
 */
const executePlanTool = async (
  toolRegistry: ToolRegistry,
  key: string,
  input: unknown,
  envelope: AgentRuntimeEnvelope,
): Promise<PlanOutput> => {
  const tool = toolRegistry.get(key)
  if (!tool) throw new Error(`测试栈：注册机里没有 ${key}`)
  const outcome = await tool.run(input, { callId: null, envelope, log: silentLogger })
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.data as PlanOutput
}

/** 测试用配置：**必须给全子 agent 相关字段**（缺了 `undefined` 进 setTimeout 会立刻超时） */
const TEST_CONFIG = {
  model: 'mock/mock-model',
  apiKey: 'test-key',
  contextTriggerRatio: 0.7,
  contextTrimTargetRatio: 0.5,
  contextCompactTargetRatio: 0.4,
  contextKeepRecentTurns: 3,
  contextToolResultMaxRatio: 0.1,
  contextFallbackWindow: 32_000,
  contextModelWindows: {},
  durableEnabled: false,
  heartbeatTimeoutMs: 60_000,
  runTimeoutMs: 60_000,
  watchdogIntervalMs: 30_000,
  multiInstance: false,
  subAgentMaxPerRun: 1,
  subAgentMaxDepth: 1,
  subAgentMaxSteps: 5,
  subAgentTimeoutMs: 60_000,
  // 命令执行（core bean `command`）：端到端要能真跑一条命令，这里给全部字段
  commandEnabled: true,
  commandTimeoutMs: 5_000,
  commandMaxOutputBytes: 64 * 1024,
} as never

const buildStack = async () => {
  db ??= new Db(
    {
      url: process.env.DB_URL!,
      sync: false,
      entities: [ConversationEntity, RunEntity, TimelineEntity],
    } as never,
    silentLogger,
  )
  if (!db.dataSource?.isInitialized) await db.onApplicationBootstrap()

  // 模型解析替身：这些测试不走"从库里取模型"那条链路（那是 ai-model 模块测试的事），
  // 但编排层现在必须拿到一个解析结果 —— 给它一个恒定的 mock 模型即可
  const modelsStub = {
    resolveForRuntime: async () => ({
      id: 'model_mock',
      modelRef: 'mock/mock-model',
      modelKey: 'mock-model',
      displayName: 'Mock 模型',
      baseURL: mock.baseURL,
      apiKey: 'test-key',
      contextWindow: null,
    }),
  } as never

  const conversationRepo = new ConversationRepository(db)
  const runs = new RunRepository(db)
  const timelines = new TimelineRepository(db)
  // 子 agent 用的是**默认模型**（由配置构造），所以配置里必须有 mock 的 baseURL ——
  // 少了它，子 agent 会退到 model router 解析而报 "No API URL found"
  const config = { ...TEST_CONFIG, baseURL: mock.baseURL } as never
  // 工具组实例（唯一的工具来源）：与 `ai.module.ts` 的装配口径一致
  const plannerStore = new PlannerStore(timelines)
  // registry 与 runner 互相引用：给 runner 一个**延迟求值**的在册端口，避免装配成环
  let toolRegistry: ToolRegistry
  // `AgentRunner` 通过 ModuleRef **惰性**取注册机（构造期不依赖它，否则成环死锁）：
  // 测试给一个只实现 `get` 的替身，语义与生产一致
  const moduleRefPort = { get: () => toolRegistry } as never
  const runner = new AgentRunner(
    runs,
    timelines,
    config,
    silentLogger,
    deps.metas,
    moduleRefPort,
  )
  toolRegistry = new ToolRegistry(
    [
      // 命令执行：与 `ai.module.ts` 的装配口径一致（assistant 已授权 bash）
      new BashTool(new CommandRunner(), silentLogger),
      new WebTools(silentLogger as never),
      new FileTools({} as never, { enabled: true } as never),
      new RunSubAgentTool(runner, silentLogger),
      new PlannerTools(plannerStore),
      new ReadToolResultTool(deps.results, deps.counter, deps.caps),
    ],
    gateway,
    deps.config,
  )
  const registry = createAgentRegistry(
    createAgentDefinitions(createPromptEngine(), toolRegistry),
    DEFAULT_AGENT_KEY,
  )
  const skillLoader = new SkillLoader(silentLogger)
  const mastra = await createMastra({
    // 模型改为"按 envelope 里的模型"求值的动态参数；这些测试不验证选模型，给恒定 mock 模型
    resolveModel: () => ({ id: 'mock/mock-model', url: mock.baseURL, apiKey: 'test-key' }),
    definitions: registry.all(),
    resolveTools: (keys) => toMastraTools(toolRegistry.toolbox(keys), silentLogger),
    resolveSkills: async (names) => toMastraSkills(await skillLoader.resolve(names)),
  })
  const conversations = new AgentConversationService(
    conversationRepo,
    runs,
    timelines,
    registry,
    silentLogger,
  )
  const context = new ContextService(timelines, config, silentLogger)
  // 附件替身：e2e 不带附件，但构造器是位置参数，少一个会让后面整体错位
  const chatAttachments = stubAttachments(silentLogger)

  const chat = new AgentChatService(
    mastra,
    registry,
    config,
    conversations,
    conversationRepo,
    runs,
    timelines,
    context,
    chatAttachments,
    {} as never,
    toolRegistry,
    deps.metas,
    skillLoader,
    modelsStub,
    silentLogger,
    createPromptEngine(),
    new AgentTitleService(timelines, createPromptEngine(), silentLogger),
  )

  const runService = new AgentRunService(runs, conversations)
  return { chat, conversations, timelines, runs, runner, runService, toolRegistry }
}

beforeAll(async () => {
  mock = await startMockModelServer()
  setAuditUserProvider(() => USER)
})

afterAll(async () => {
  setAuditUserProvider(undefined)
  if (stackPromise) {
    /**
     * 清理这次跑出来的数据：本文件用例多、会话是 `chat.chat()` 直连建的，**没有逐个登记 id**，
     * 所以按测试用户整批删。不清理的代价很实在：`DB_URL` 指向哪个库就往哪儿写 ——
     * 开发机上就是开发库，跑一次就多一堆"看着像真会话"的假数据（还会出现在会话页侧栏里）。
     */
    await db.dataSource.query(
      'DELETE FROM timelines WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = $1)',
      [USER],
    )
    await db.dataSource.query(
      'DELETE FROM runs WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = $1)',
      [USER],
    )
    await db.dataSource.query('DELETE FROM conversations WHERE user_id = $1', [USER])
    await db.onApplicationShutdown()
  }
  await mock.close()
})
