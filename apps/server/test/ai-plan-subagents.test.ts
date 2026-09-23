import 'dotenv/config'
import { Db, setAuditUserProvider } from '@repo/kits'
import { RunStatus, TimelineKind } from '@repo/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConversationEntity } from '../src/database/entities/conversation-entity.js'
import { RunEntity } from '../src/database/entities/run-entity.js'
import { TimelineEntity } from '../src/database/entities/timeline-entity.js'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from '../src/modules/ai/agents/index.js'
import { createMastra } from '../src/modules/ai/core/ai.mastra.js'
import { createAgentRegistry } from '../src/modules/ai/core/ai.registry.js'
import type { AgentSpec } from '../src/modules/ai/core/ai.types.js'
import type { AgentCore } from '../src/modules/ai/core/ai.core.types.js'
import { PlannerCore } from '../src/modules/ai/core/planner.core.js'
import { SubAgentCore } from '../src/modules/ai/core/subagent.core.js'
import { createPromptEngine } from '../src/modules/ai/prompts/index.js'
import { SkillLoader } from '../src/modules/ai/skills/index.js'
import { ListTodosTool } from '../src/modules/ai/tools/list-todos.tool.js'
import { GetTodoTool } from '../src/modules/ai/tools/get-todo.tool.js'
import { CreateTodoTool } from '../src/modules/ai/tools/create-todo.tool.js'
import { ToolBuilder } from '../src/modules/ai/tools/tool.builder.js'
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
  MOCK_PLAN,
  MOCK_PLAN_MARKER,
  MOCK_SUBAGENT_NAME,
  MOCK_SUBAGENT_PROMPT,
  MOCK_SUBAGENT_TASK,
  type MockModelServer,
  startMockModelServer,
} from './helpers/mock-model-server.js'

/**
 * 规划能力与**动态子 agent**（设计文档 §3.14）：
 * - core bean：`PlannerCore` / `SubAgentCore` 用 `asTools()` 交出能力，`ToolBuilder` 把
 *   「业务工具 + core 工具」拍平成一张表；
 * - 规划：`write-plan` 无状态全量覆盖 + 运行时落成时间线的 `plan` 事件；
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

const todoService = {
  async page() {
    return { items: [], total: 0, page: 1, size: 3 }
  },
  async get() {
    return { id: 't1', title: 'x', description: null, completed: false, createdAt: new Date(), updatedAt: new Date() }
  },
  async create() {
    return { id: 't2', title: 'x', description: null, completed: false, createdAt: new Date(), updatedAt: new Date() }
  },
} as never

/** 业务工具 + core bean 两个来源（与 `ai.module.ts` 的装配口径一致） */
const buildToolBuilder = (cores: AgentCore[] = []): ToolBuilder =>
  new ToolBuilder(
    [new ListTodosTool(todoService), new GetTodoTool(todoService), new CreateTodoTool(todoService)],
    cores,
  )

/** 测试用的 agent 声明（只关心工具授权，故其余字段按空补上） */
const spec = (partial: Partial<AgentSpec> & { key: string }): AgentSpec => ({
  name: partial.key,
  description: partial.key,
  tools: [],
  skills: [],
  prompt: { template: 'assistant' },
  ...partial,
})

describe('规划能力（core bean + write-plan + plan 事件）', () => {
  it('PlannerCore 通过 asTools() 交出 write-plan（工具是"全量覆盖"的无状态语义）', async () => {
    const core = new PlannerCore()
    expect(core.key).toBe('planner')
    const tools = core.asTools()
    expect(tools.map((tool) => tool.key)).toEqual(['write-plan'])
    // 规划不是委派类工具
    expect(tools[0].delegation).toBeUndefined()

    const execute = (tools[0].tool as unknown as {
      execute: (input: unknown) => Promise<{ summary: string; steps: unknown[] }>
    }).execute
    const result = await execute(MOCK_PLAN)
    expect(result.summary).toContain('2 步')
    expect(result.steps).toHaveLength(2)
  })

  it('ToolBuilder 把「业务工具」与「core bean 工具」拍平成一张表；重复 key 启动期报错', () => {
    const builder = buildToolBuilder([new PlannerCore()])
    expect(builder.keys()).toEqual(
      expect.arrayContaining(['list-todos', 'get-todo', 'create-todo', 'write-plan']),
    )
    // 同一个 key 由两个来源提供 → 装配错误（宁可起不来，也不要静默覆盖）
    const duplicated: AgentCore = {
      key: 'fake',
      asTools: () => [
        {
          key: 'list-todos',
          title: 'x',
          description: 'x',
          tool: {} as never,
        },
      ],
    }
    expect(() => buildToolBuilder([duplicated])).toThrow(/工具 key 重复/)
  })

  it('只有 write-plan 的输出会被认成计划（别的工具不会误伤）', () => {
    expect(toPlanPayload('list-todos', { items: [] })).toBeNull()
    expect(toPlanPayload('write-plan', { goal: 'g', steps: [] })).toMatchObject({ goal: 'g' })
    expect(toPlanPayload('write-plan', { goal: 'g' })).toBeNull()
  })

  it('端到端：模型调用 write-plan → 时间线出现 plan 事件（内容完整）', async () => {
    const { chat, conversations, timelines } = await stack()
    const result = await chat.chat(USER, { message: `请分步来做 ${MOCK_PLAN_MARKER}` })
    const page = await timelines.list({ conversationId: result.conversationId, page: 1, size: 100 })

    const planRows = page.items.filter((item) => item.kind === TimelineKind.Plan)
    expect(planRows).toHaveLength(1)
    expect(planRows[0].payload).toMatchObject({ goal: MOCK_PLAN.goal, steps: MOCK_PLAN.steps })
    // 计划事件紧跟在工具结果之后（seq 连续，前端按顺序渲染）
    const toolResult = page.items.find((item) => item.kind === TimelineKind.ToolResult)
    expect(planRows[0].seq).toBeGreaterThan(toolResult!.seq)

    const conversation = await conversations.detail(USER, { conversationId: result.conversationId })
    expect(conversation.id).toBe(result.conversationId)
  }, 30_000)
})

describe('子 agent（core bean + 运行期动态创建）', () => {
  it('工具面：子 agent = 全部工具 − 委派类（于是它不能再造子 agent）', () => {
    const builder = buildToolBuilder([new PlannerCore(), fakeSpawnerCore()])
    expect(builder.delegationKeys()).toEqual([MOCK_DELEGATE_TOOL])
    const childTools = builder.buildDelegable()
    expect(Object.keys(childTools)).toEqual(
      expect.arrayContaining(['list-todos', 'get-todo', 'create-todo', 'write-plan']),
    )
    // 关键：子 agent 拿不到委派工具 → 递归在**能力上**不可能，不靠提示词自律
    expect(Object.keys(childTools)).not.toContain(MOCK_DELEGATE_TOOL)
  })

  it('对外清单用 canSpawnSubAgents 表达能力（不再有静态子 agent 名单）', () => {
    const registry = createAgentRegistry(
      [
        spec({ key: 'a', tools: ['list-todos', MOCK_DELEGATE_TOOL] }),
        spec({ key: 'b', tools: ['list-todos'] }),
      ],
      'a',
    )
    const list = registry.list()
    expect(list.agents.find((agent) => agent.key === 'a')?.canSpawnSubAgents).toBe(true)
    expect(list.agents.find((agent) => agent.key === 'b')?.canSpawnSubAgents).toBe(false)
  })

  it('Mastra 装配里不再有静态子 agent（`agents:{}` 已删除）', async () => {
    const toolBuilder = buildToolBuilder([new PlannerCore(), fakeSpawnerCore()])
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

    // 子 agent 的请求：system 是主 agent 现写的提示词；tools 有业务工具、没有 run-sub-agent
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
    expect(toolNames).toContain('list-todos')
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
}> | null = null

const stack = async () => {
  stackPromise ??= buildStack()
  return stackPromise
}

/**
 * 纯装配断言用的"假委派类 core"：只暴露一个带 `delegation` 标记的工具。
 *
 * 这样"工具面 = 全部 − 委派类"这条规则可以脱离数据库与模型单独验证。
 */
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
  const toolBuilder = buildToolBuilder([new PlannerCore(), new SubAgentCore(runner, silentLogger)])
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
  )

  const runService = new AgentRunService(runs, conversations)
  return { chat, conversations, timelines, runs, runner, runService }
}

beforeAll(async () => {
  mock = await startMockModelServer()
  setAuditUserProvider(() => USER)
})

afterAll(async () => {
  setAuditUserProvider(undefined)
  if (stackPromise) {
    await db.onApplicationShutdown()
  }
  await mock.close()
})
