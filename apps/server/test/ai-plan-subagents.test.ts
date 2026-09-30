import 'dotenv/config'
import { CommandRunner, Db, setAuditUserProvider } from '@repo/kits'
import { RunStatus, TimelineKind, TimelineRole } from '@repo/shared'
import { RequestContext } from '@mastra/core/request-context'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConversationEntity } from '../src/database/entities/conversation-entity.js'
import { RunEntity } from '../src/database/entities/run-entity.js'
import { TimelineEntity } from '../src/database/entities/timeline-entity.js'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from '../src/modules/ai/agents/index.js'
import { createMastra } from '../src/modules/ai/core/ai.mastra.js'
import { createAgentRegistry } from '../src/modules/ai/core/ai.registry.js'
import type { AgentSpec } from '../src/modules/ai/core/ai.types.js'
import {
  AGENT_RUNTIME_KEY,
  type AgentCore,
  type AgentRuntimeEnvelope,
} from '../src/modules/ai/core/ai.core.types.js'
import { PlannerCore, type TodoWriteOutput } from '../src/modules/ai/core/planner.core.js'
import { SubAgentCore } from '../src/modules/ai/core/subagent.core.js'
import { CommandCore } from '../src/modules/ai/core/command.core.js'
import { createPromptEngine } from '../src/modules/ai/prompts/index.js'
import { AgentTitleService } from '../src/modules/ai/runtime/title.service.js'
import { SkillLoader } from '../src/modules/ai/skills/index.js'
import { ToolBuilder } from '../src/modules/ai/tools/tool.builder.js'
import { TOOL_KEYS } from '../src/modules/ai/tools/tool-keys.js'
import type { AgentTool } from '../src/modules/ai/tools/tools.types.js'
import { toPlanPayload } from '../src/modules/ai/runtime/plan.js'
import { AgentChatService } from '../src/modules/ai/runtime/chat.service.js'
import { AgentRunner } from '../src/modules/ai/runtime/agent-runner.js'
import { AgentConversationService } from '../src/modules/ai/runtime/conversation.service.js'
import { AgentRunService } from '../src/modules/ai/runtime/run.service.js'
import { ConversationRepository } from '../src/modules/ai/runtime/conversation.repository.js'
import { ContextService } from '../src/modules/ai/runtime/context.service.js'
import { RunRepository } from '../src/modules/ai/runtime/run.repository.js'
import { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'
import {
  MOCK_CHILD_TEXT,
  MOCK_DELEGATE_MARKER,
  MOCK_DELEGATE_TOOL,
  MOCK_SUBAGENT_NAME,
  MOCK_SUBAGENT_PROMPT,
  MOCK_SUBAGENT_TASK,
  MOCK_TODO_INITIAL,
  MOCK_TODO_OVERWRITE,
  MOCK_TODO_OVERWRITE_MARKER,
  MOCK_TODO_REACT_MARKER,
  MOCK_TODO_REACT_SECOND,
  MOCK_TODO_TOOL,
  type MockModelServer,
  startMockModelServer,
} from './helpers/mock-model-server.js'

/**
 * 规划能力（任务清单）与**动态子 agent**（设计文档 §3.14）：
 * - core bean：`PlannerCore` / `SubAgentCore` 用 `asTools()` 交出能力，`ToolBuilder` 把
 *   「业务工具（当前为空）+ core 工具」拍平成一张表；
 * - 规划：`todo-write` 提交**完整任务清单**（全量覆盖语义）——加任务 / 删任务 / 改状态 /
 *   重规划都由同一份清单的不同版本表达；工具**自己不写库**，由运行时落成时间线的 `plan` 事件
 *   （append-only，「当前计划」= 最后一条）；
 * - 子 agent：**运行期由工具创建**（提示词由主 agent 现写）、工具面 = 全部 − 委派类、
 *   一切明细入库（独立 run + 完整时间线）、消耗汇总进父、同一 toolCallId 幂等复用。
 */

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

/** 业务工具为空 + core bean 两个来源（与 `ai.module.ts` 的装配口径一致） */
const buildToolBuilder = (cores: AgentCore[] = []): ToolBuilder => new ToolBuilder([], cores)

/** 测试用的 agent 声明（只关心工具授权，故其余字段按空补上） */
const spec = (partial: Partial<AgentSpec> & { key: string }): AgentSpec => ({
  name: partial.key,
  description: partial.key,
  tools: [],
  skills: [],
  prompt: { template: 'assistant' },
  ...partial,
})

describe('规划能力（core bean + todo-write + plan 事件）', () => {
  it('PlannerCore 通过 asTools() 交出唯一的 todo-write（全量清单语义，不是委派类工具）', () => {
    const core = new PlannerCore(stubTimeline)
    expect(core.key).toBe('planner')
    const tools = core.asTools()
    expect(tools.map((tool) => tool.key)).toEqual([TOOL_KEYS.todoWrite])
    expect(tools[0].key).toBe(MOCK_TODO_TOOL)
    // 规划不是委派类工具：子 agent 也能拿到它（工具面 = 全部 − 委派类）
    expect(tools[0].delegation).toBeUndefined()
  })

  it('ToolBuilder：业务工具允许为空，但 core bean 必须交出工具；重复 key 启动期报错', () => {
    const builder = buildToolBuilder([new PlannerCore(stubTimeline)])
    expect(builder.keys()).toEqual([TOOL_KEYS.todoWrite])

    // 一个工具都没有（业务工具空 + core 也没交）→ 装配错误（宁可起不来，也不要静默少能力）
    expect(() => buildToolBuilder([])).toThrow(/core bean 未提供任何工具/)

    // 同一个 key 由两个来源提供 → 装配错误（宁可起不来，也不要静默覆盖）
    const duplicated: AgentCore = {
      key: 'fake',
      asTools: () => [
        { key: TOOL_KEYS.todoWrite, title: 'x', description: 'x', tool: {} as never },
      ],
    }
    expect(() => buildToolBuilder([new PlannerCore(stubTimeline), duplicated])).toThrow(
      /工具 key 重复/,
    )
  })

  it('只有 todo-write 的输出会被认成计划（别的工具不会误伤，形状不对也不认）', () => {
    const output = { ...MOCK_TODO_INITIAL, revision: 1, summary: '共 2 项' }
    expect(toPlanPayload(MOCK_DELEGATE_TOOL, output)).toBeNull()
    expect(toPlanPayload(TOOL_KEYS.todoWrite, output)).toMatchObject({
      goal: MOCK_TODO_INITIAL.goal,
      revision: 1,
    })
    // 缺 revision / tasks 形状不对 → 不认（半真半假的计划不如没有）
    expect(toPlanPayload(TOOL_KEYS.todoWrite, { goal: 'g', tasks: [] })).toBeNull()
    expect(toPlanPayload(TOOL_KEYS.todoWrite, { goal: 'g', revision: 1 })).toBeNull()
    // 状态必须落在三态里
    expect(
      toPlanPayload(TOOL_KEYS.todoWrite, {
        goal: 'g',
        revision: 1,
        tasks: [{ id: 't1', title: 'x', status: 'blocked' }],
      }),
    ).toBeNull()
  })

  it('① 首次提交：模型调 todo-write → plan 事件（payload 含 goal/tasks/revision=1）', async () => {
    const { chat, conversations } = await stack()
    const result = await chat.chat(USER, { message: '帮我把待办整理成周报' })
    expect(result.status).toBe(RunStatus.Succeeded)
    expect(result.toolCallCount).toBe(1)

    const plans = await planEvents(result.conversationId)
    expect(plans).toHaveLength(1)
    // payload 就是那一版清单本身（goal / revision / tasks），不夹带摘要
    expect(plans[0].payload).toEqual({
      goal: MOCK_TODO_INITIAL.goal,
      revision: 1,
      tasks: MOCK_TODO_INITIAL.tasks,
    })
    // 计划事件紧跟在工具结果之后（seq 连续，前端按顺序渲染）
    const page = await timelinesPage(result.conversationId)
    const toolResult = page.items.find((item) => item.kind === TimelineKind.ToolResult)
    expect(plans[0].seq).toBeGreaterThan(toolResult!.seq)

    const conversation = await conversations.detail(USER, { conversationId: result.conversationId })
    expect(conversation.id).toBe(result.conversationId)
  }, 30_000)

  it('② 全量覆盖：第二轮提交改动后的清单 → 新 plan 事件（revision=2，且就是提交的那一份）', async () => {
    const { chat } = await stack()
    const first = await chat.chat(USER, { message: '把待办整理成周报' })
    const second = await chat.chat(USER, {
      conversationId: first.conversationId,
      message: `按新口径再来一版 ${MOCK_TODO_OVERWRITE_MARKER}`,
    })
    expect(second.status).toBe(RunStatus.Succeeded)

    const plans = await planEvents(first.conversationId)
    expect(plans.map((item) => (item.payload as { revision: number }).revision)).toEqual([1, 2])
    // 一份提交同时表达"换目标 / 改状态 / 加任务 / 删任务"：
    // t1 变 completed、t3 新增、**t2 不再出现即视为删除**
    expect(plans[1].payload).toEqual({
      goal: MOCK_TODO_OVERWRITE.goal,
      revision: 2,
      tasks: MOCK_TODO_OVERWRITE.tasks,
    })

    // 工具出参里能看到这次改了哪几项（模型据此确认自己的改动生效了）
    const page = await timelinesPage(first.conversationId)
    const results = page.items.filter(
      (item) => item.kind === TimelineKind.ToolResult && item.runId === second.runId,
    )
    const output = results[0]?.payload?.output as TodoWriteOutput
    expect(output.summary).toContain('删除 t2')
    expect(output.summary).toContain('t1 in_progress→completed')
    expect(output.summary).toContain('新增 t3')
  }, 30_000)

  it('③ 同一轮内连续两次提交：第二次读到第一次新增的任务（revision=1 → 2）', async () => {
    const { chat } = await stack()
    // 全新会话：这一轮本身就是首次提交 —— 第一次是 revision=1，第二次必须是 2
    const result = await chat.chat(USER, { message: `一口气把清单写两版 ${MOCK_TODO_REACT_MARKER}` })
    expect(result.status).toBe(RunStatus.Succeeded)
    // 一轮里真的调了两次 `todo-write`
    expect(result.toolCallCount).toBe(2)

    const page = await timelinesPage(result.conversationId)
    const runPlans = page.items.filter(
      (item) => item.kind === TimelineKind.Plan && item.runId === result.runId,
    )
    // 运行时在**整轮结束后**才落库：此刻时间线上一条 `plan` 事件都没有。
    // 第二次能算出 revision=2（而不是又算一次 1），只能是因为它读到了
    // 第一次在本轮内存里留下的结果 —— 这就是"react 循环里能调整清单"的硬证明。
    expect(runPlans.map((item) => (item.payload as { revision: number }).revision)).toEqual([1, 2])
    expect(runPlans[1].payload).toEqual({
      goal: MOCK_TODO_REACT_SECOND.goal,
      revision: 2,
      tasks: MOCK_TODO_REACT_SECOND.tasks,
    })

    // 第二次提交的入参里**带着第一次新增的 r2**（并把它标成了 completed）
    const calls = page.items.filter(
      (item) =>
        item.kind === TimelineKind.ToolCall &&
        item.toolKey === MOCK_TODO_TOOL &&
        item.runId === result.runId,
    )
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(calls[1].payload?.input)).toContain('r2')
    expect(calls[1].payload?.input).toMatchObject({ tasks: MOCK_TODO_REACT_SECOND.tasks })
  }, 30_000)

  it('④ 同时多个 in_progress：不阻断提交，但在出参里给出纪律提示', async () => {
    const { planner, timelines, conversations, runs } = await stack()
    const conversation = await conversations.create(USER, {})
    const run = await runs.create({
      conversationId: conversation.id,
      agentKey: DEFAULT_AGENT_KEY,
      status: RunStatus.Running,
    })

    const output = await executeTodoWrite(
      planner,
      {
        goal: '并行推进两件事',
        tasks: [
          { id: 'a', title: '写方案', status: 'in_progress' },
          { id: 'b', title: '拉数据', status: 'in_progress' },
        ],
      },
      runtimeContext(conversation.id, run.id),
    )

    expect(output.revision).toBe(1)
    expect(output.tasks).toHaveLength(2)
    expect(output.summary).toContain('共 2 项')
    expect(output.warnings?.[0]).toContain('同时只应有一个进行中')

    // 工具**自己不写库**：落 `plan` 事件是运行时的职责（这里没有运行时，时间线必须还是空的）
    expect(await timelines.latestPlan(conversation.id)).toBeNull()
    await runs.finish(run.id, { status: RunStatus.Canceled })
  }, 30_000)

  it('⑤ 当前计划从时间线读：上一版 revision=1 → 本次提交是 revision=2，且沿用未给的目标', async () => {
    const { planner, timelines, conversations, runs } = await stack()
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
    const output = await executeTodoWrite(
      planner,
      { tasks: [{ id: 'n1', title: '按主题分组', status: 'in_progress' }] },
      runtimeContext(conversation.id, `${run.id}_next`),
    )

    expect(output.revision).toBe(2)
    expect(output.goal).toBe('把待办整理成周报') // goal 省略 → 沿用时间线里的目标
    expect(output.tasks.map((task) => task.id)).toEqual(['n1'])
    expect(output.summary).toContain('删除 old1')

    await runs.finish(run.id, { status: RunStatus.Canceled })
  }, 30_000)

  it('入参校验：首次提交必须给 goal；同一份清单里 id 重复要报错', async () => {
    const { planner, conversations, runs } = await stack()
    const conversation = await conversations.create(USER, {})
    const run = await runs.create({
      conversationId: conversation.id,
      agentKey: DEFAULT_AGENT_KEY,
      status: RunStatus.Running,
    })

    // 这个会话里**还没有任何计划** → 省略 goal 无从沿用，必须报错
    await expect(
      executeTodoWrite(
        planner,
        { tasks: [{ title: '没有目标' }] },
        runtimeContext(conversation.id, `${run.id}_blank`),
      ),
    ).rejects.toThrow(/必须给 goal/)

    // 同一份清单里 id 重复 → 拒绝（否则"改状态"就会变成掷骰子）
    await expect(
      executeTodoWrite(
        planner,
        {
          goal: 'x',
          tasks: [
            { id: 'dup', title: 'a', status: 'pending' },
            { id: 'dup', title: 'b', status: 'pending' },
          ],
        },
        runtimeContext(conversation.id, `${run.id}_dup`),
      ),
    ).rejects.toThrow(/id 重复/)

    await runs.finish(run.id, { status: RunStatus.Canceled })
  }, 30_000)
})

describe('子 agent（core bean + 运行期动态创建）', () => {
  it('工具面：子 agent = 全部工具 − 委派类（于是它不能再造子 agent）', () => {
    const builder = buildToolBuilder([new PlannerCore(stubTimeline), fakeSpawnerCore()])
    expect(builder.delegationKeys()).toEqual([MOCK_DELEGATE_TOOL])
    const childTools = builder.buildDelegable()
    expect(Object.keys(childTools)).toEqual(expect.arrayContaining([TOOL_KEYS.todoWrite]))
    // 关键：子 agent 拿不到委派工具 → 递归在**能力上**不可能，不靠提示词自律
    expect(Object.keys(childTools)).not.toContain(MOCK_DELEGATE_TOOL)
  })

  it('对外清单用 canSpawnSubAgents 表达能力（不再有静态子 agent 名单）', () => {
    const registry = createAgentRegistry(
      [
        spec({ key: 'a', tools: [TOOL_KEYS.todoWrite, MOCK_DELEGATE_TOOL] }),
        spec({ key: 'b', tools: [TOOL_KEYS.todoWrite] }),
      ],
      'a',
    )
    const list = registry.list()
    expect(list.agents.find((agent) => agent.key === 'a')?.canSpawnSubAgents).toBe(true)
    expect(list.agents.find((agent) => agent.key === 'b')?.canSpawnSubAgents).toBe(false)
  })

  it('Mastra 装配里不再有静态子 agent（`agents:{}` 已删除）', async () => {
    const toolBuilder = buildToolBuilder([
      new PlannerCore(stubTimeline),
      fakeSpawnerCore(),
      fakeCommandCore(),
    ])
    const registry = createAgentRegistry(
      createAgentDefinitions(createPromptEngine(), toolBuilder),
      DEFAULT_AGENT_KEY,
    )
    const mastra = await createMastra({
      model: { model: 'mock/mock-model', apiKey: 'k', baseURL: 'http://127.0.0.1:1/v1' },
      definitions: registry.all(),
      resolveTools: (keys) => toolBuilder.build(keys),
      resolveSkills: (names) => new SkillLoader(silentLogger).resolve(names),
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
    expect(toolNames).toContain(MOCK_TODO_TOOL)
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
      envelope: {
        conversationId: conversation.id,
        parentRunId: result.runId,
        triggeredBy: USER,
        depth: 0,
        childTools: {},
        childSkills: [],
      },
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
      envelope: {
        conversationId: conversation.id,
        parentRunId: result.runId,
        triggeredBy: USER,
        depth: 0,
        childTools: {},
        childSkills: [],
      },
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
  planner: PlannerCore
  toolBuilder: ToolBuilder
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

/** 手工装配运行时信封（直接执行工具时用；域内只关心会话与 run） */
const runtimeContext = (
  conversationId: string,
  parentRunId: string,
): { requestContext: RequestContext } => {
  const requestContext = new RequestContext()
  const envelope = {
    conversationId,
    parentRunId,
    triggeredBy: USER,
    depth: 0,
    childTools: {},
    childSkills: [],
  } as unknown as AgentRuntimeEnvelope
  requestContext.setRaw(AGENT_RUNTIME_KEY, envelope)
  return { requestContext }
}

/** 直接执行 `todo-write`（绕过模型，验证工具本身的契约） */
const executeTodoWrite = async (
  planner: PlannerCore,
  input: unknown,
  context: { requestContext: RequestContext },
): Promise<TodoWriteOutput> => {
  const tool = planner.asTools().find((item) => item.key === TOOL_KEYS.todoWrite) as AgentTool
  const instance = tool.tool as unknown as {
    execute: (value: unknown, ctx: unknown) => Promise<TodoWriteOutput>
  }
  return instance.execute(input, context)
}

/**
 * 纯装配断言用的"假委派类 core"：只暴露一个带 `delegation` 标记的工具。
 *
 * 这样"工具面 = 全部 − 委派类"这条规则可以脱离数据库与模型单独验证。
 */
/** 命令执行 core 的替身：只关心"工具清单能不能渲染出来"的用例用它，不真跑命令 */
const fakeCommandCore = (): AgentCore => ({
  key: 'fake-command',
  asTools: () => [
    {
      key: TOOL_KEYS.runCommand,
      title: '执行命令行命令',
      description: 'x',
      tool: {} as never,
    },
  ],
})

const fakeSpawnerCore = (): AgentCore => ({
  key: 'fake-subagent',
  asTools: () => [
    {
      key: MOCK_DELEGATE_TOOL,
      title: '创建子助手',
      description: 'x',
      delegation: true,
      tool: {} as never,
    },
  ],
})

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
  const runner = new AgentRunner(runs, timelines, config, silentLogger)
  const skillLoader = new SkillLoader(silentLogger)
  const planner = new PlannerCore(timelines)
  const toolBuilder = buildToolBuilder([
    planner,
    new SubAgentCore(runner, silentLogger),
    // 命令执行 core：与 `ai.module.ts` 的装配口径一致（assistant 已授权 run-command）
    new CommandCore(new CommandRunner(), config, silentLogger),
  ])
  const registry = createAgentRegistry(
    createAgentDefinitions(createPromptEngine(), toolBuilder),
    DEFAULT_AGENT_KEY,
  )
  const mastra = await createMastra({
    // 模型改为"按 requestContext 解析"的动态参数；这些测试不验证选模型，给恒定 mock 模型
    resolveModel: () => ({ id: 'mock/mock-model', url: mock.baseURL, apiKey: 'test-key' }),
    definitions: registry.all(),
    resolveTools: (keys) => toolBuilder.build(keys),
    resolveSkills: (names) => skillLoader.resolve(names),
  })
  const conversations = new AgentConversationService(
    conversationRepo,
    runs,
    timelines,
    registry,
    silentLogger,
  )
  const context = new ContextService(timelines, config, silentLogger)
  const chat = new AgentChatService(
    mastra,
    registry,
    config,
    conversations,
    conversationRepo,
    runs,
    timelines,
    context,
    {} as never,
    toolBuilder,
    skillLoader,
    modelsStub,
    silentLogger,
    createPromptEngine(),
    new AgentTitleService(timelines, createPromptEngine(), silentLogger),
  )

  const runService = new AgentRunService(runs, conversations)
  return { chat, conversations, timelines, runs, runner, runService, planner, toolBuilder }
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
