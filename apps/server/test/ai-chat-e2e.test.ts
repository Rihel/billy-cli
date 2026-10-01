import 'dotenv/config'
import { CommandRunner, Db, describePlatform, resolveShell, setAuditUserProvider } from '@repo/kits'
import { AppErrorCodes, RunStatus, TimelineKind } from '@repo/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConversationEntity } from '../src/database/entities/conversation-entity.js'
import { RunEntity } from '../src/database/entities/run-entity.js'
import { TimelineEntity } from '../src/database/entities/timeline-entity.js'
import {
  AGENT_SPECS,
  DEFAULT_AGENT_KEY,
  createAgentDefinitions,
} from '../src/modules/ai/agents/index.js'
import { AGENT_MAX_STEPS } from '../src/modules/ai/core/constants.js'
import { createMastra } from '../src/modules/ai/mastra/ai.mastra.js'
import { createAgentRegistry } from '../src/modules/ai/agents/registry.js'
import { createPromptEngine } from '../src/modules/ai/core/prompts/index.js'
import { AgentTitleService } from '../src/modules/ai/runtime/title.service.js'
import { SkillLoader } from '../src/modules/ai/core/skills/index.js'
import { RunCommandTool } from '../src/modules/ai/tools/command.tool.js'
import { RunSubAgentTool } from '../src/modules/ai/tools/subagent.tool.js'
import { PlannerStore, PlannerTools } from '../src/modules/ai/tools/planner/index.js'
import {
  TOOL_CALL_REASON_FIELD,
  TOOL_CALL_REASON_MAX,
  TOOL_CALL_REASON_MIN,
} from '../src/modules/ai/core/tools/call-reason.js'
import { AgentRunner } from '../src/modules/ai/runtime/agent-runner.js'
import { AgentChatService } from '../src/modules/ai/runtime/chat.service.js'
import { toMastraSkills } from '../src/modules/ai/mastra/skill.adapter.js'
import { toMastraTools } from '../src/modules/ai/mastra/tool.adapter.js'
import { ReadToolResultTool } from '../src/modules/ai/tools/read-tool-result.tool.js'
import { ToolGateway } from '../src/modules/ai/core/tools/tool.gateway.js'
import { ToolRegistry } from '../src/modules/ai/core/tools/tool.registry.js'
import { buildToolStackDeps } from './helpers/ai-tool-stack.js'
import { AgentConversationService } from '../src/modules/ai/runtime/conversation.service.js'
import { ConversationRepository } from '../src/modules/ai/runtime/conversation.repository.js'
import { ContextService } from '../src/modules/ai/runtime/context.service.js'
import { RunRepository } from '../src/modules/ai/runtime/run.repository.js'
import { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'
import {
  MOCK_COMMAND,
  MOCK_COMMAND_MARKER,
  MOCK_COMMAND_OUTPUT,
  MOCK_COMMAND_TOOL,
  MOCK_FINAL_TEXT,
  MOCK_NO_REASON_FIXED,
  MOCK_NO_REASON_MARKER,
  MOCK_PLAN_CREATE_TOOL,
  MOCK_PLAN_INITIAL,
  MOCK_REASON,
  MOCK_TITLE_TEXT,
  type MockModelServer,
  startMockModelServer,
} from './helpers/mock-model-server.js'

/**
 * 对话链路端到端测试：**假模型（本地 mock）+ 真实数据库**，不需要任何外部密钥。
 *
 * 验证的是"真的跑通一条链路"：
 *   建 run → 组装上下文 → 落用户消息 → 模型调工具（真实执行 core bean 的 `plan-create`）
 *   → 落时间线（入参出参完整、计划落成 `plan` 事件）→ 收尾（消耗 / 步数 / 轮数 / 标题）
 *   → 数据可查、可复盘。
 *
 * AI 模块已与业务模块解耦：`AGENT_TOOL_GROUPS` 只登记四个工具组（规划 / 命令 / 子 agent / 取页），
 * 没有业务工具组。
 */

const USER = 'user_ai_e2e'
const silentLogger = {
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

let db: Db
let mock: MockModelServer
let chat: AgentChatService
let conversations: AgentConversationService
let conversationRepo: ConversationRepository
let runs: RunRepository
let timelines: TimelineRepository
/** 测试配置：子 agent 字段必须给全（`undefined` 进 setTimeout 会立刻超时） */
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
  subAgentMaxPerRun: 3,
  subAgentMaxDepth: 1,
  subAgentMaxSteps: 5,
  subAgentTimeoutMs: 60_000,
  // 命令执行（core bean `command`）：端到端要能真跑一条命令，这里给全部字段
  commandEnabled: true,
  commandTimeoutMs: 5_000,
  commandMaxOutputBytes: 64 * 1024,
}

const createdConversationIds: string[] = []

beforeAll(async () => {
  mock = await startMockModelServer()

  db = new Db(
    {
      url: process.env.DB_URL!,
      sync: false,
      entities: [ConversationEntity, RunEntity, TimelineEntity],
    } as never,
    silentLogger,
  )
  await db.onApplicationBootstrap()

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

  if (!db.dataSource.isInitialized) throw new Error('数据库初始化失败')

  conversationRepo = new ConversationRepository(db)
  runs = new RunRepository(db)
  timelines = new TimelineRepository(db)

  // 这份配置要能用"默认模型"造子 agent（跑不跑是另一回事）：baseURL 缺了会退到 model router 报错
  const config = { ...TEST_CONFIG, baseURL: mock.baseURL } as never
  // 工具引擎装配（设计 §5.9）：配置 / 限流 / 时钟用测试替身，插件链为空（e2e 只关心行为）
  const deps = buildToolStackDeps()
  const gateway = new ToolGateway(deps.config, silentLogger, [], deps.clock)
  // registry 与 runner 互相引用：runner 只在运行时用 registry 做"工具是否在册"判定，
  // 所以给 runner 一个**延迟求值**的端口，先建 runner 再建真正的 registry（不成环）
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
  // 工具组实例（唯一的工具来源）：与 `ai.module.ts` 的装配口径一致
  const plannerStore = new PlannerStore(timelines)
  toolRegistry = new ToolRegistry(
    [
      new RunCommandTool(new CommandRunner(), silentLogger),
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

  conversations = new AgentConversationService(
    conversationRepo,
    runs,
    timelines,
    registry,
    silentLogger,
  )
  const context = new ContextService(timelines, config, silentLogger)

  chat = new AgentChatService(
    mastra,
    registry,
    config,
    conversations,
    conversationRepo,
    runs,
    timelines,
    context,
    // 非流式路径不碰 Redis：这里给一个最小替身（流式链路有专门的端到端测试覆盖）
    {} as never,
    toolRegistry,
    deps.metas,
    skillLoader,
    modelsStub,
    silentLogger,
    createPromptEngine(),
    new AgentTitleService(timelines, createPromptEngine(), silentLogger),
  )

  setAuditUserProvider(() => USER)
})

afterAll(async () => {
  setAuditUserProvider(undefined)
  for (const id of createdConversationIds) {
    await db.dataSource.query('DELETE FROM timelines WHERE conversation_id = $1', [id])
    await db.dataSource.query('DELETE FROM runs WHERE conversation_id = $1', [id])
    await db.dataSource.query('DELETE FROM conversations WHERE id = $1', [id])
  }

  /**
   * 兜底：有些会话是经 HTTP / 流式端点建的、**没进 `createdConversationIds`** ——
   * 按测试用户再扫一遍。不扫的代价很实在：`DB_URL` 指向哪个库就往哪儿写，开发机上就是开发库，
   * 每跑一次测试都会多出一堆"看着像真会话"的假数据（还会出现在会话页侧栏里）。
   */
  for (const userId of [USER]) {
    await db.dataSource.query(
      'DELETE FROM timelines WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = $1)',
      [userId],
    )
    await db.dataSource.query(
      'DELETE FROM runs WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = $1)',
      [userId],
    )
    await db.dataSource.query('DELETE FROM conversations WHERE user_id = $1', [userId])
  }
  await db.onApplicationShutdown()
  await mock.close()
})

describe('对话链路端到端（mock 模型 + 真实数据库）', () => {
  it('一轮问答：工具被真实调用、入参出参完整落库、消耗与统计收尾', async () => {
    const result = await chat.chat(USER, { message: '帮我看看最近有哪些待办' })
    createdConversationIds.push(result.conversationId)

    // 1) 收尾结果
    expect(result.status).toBe(RunStatus.Succeeded)
    expect(result.content).toBe(MOCK_FINAL_TEXT)
    // 一轮里两步：先调工具，再组织回答
    expect(result.stepCount).toBeGreaterThanOrEqual(2)
    expect(result.toolCallCount).toBe(1)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)

    // 2) 运行记录：终态 + 消耗 + 统计 + **输入快照**（复盘的输入侧证据）
    const run = await runs.findEntity(result.runId)
    expect(run?.status).toBe(RunStatus.Succeeded)
    expect(run?.stepCount).toBe(result.stepCount)
    expect(run?.usage).toMatchObject({ totalTokens: expect.any(Number) })
    expect(run?.requestSnapshot).toMatchObject({
      agentKey: DEFAULT_AGENT_KEY,
      // 断言"落库的上限 = 运行时实际用的那个"，不写死数字（改上限时不要假红）
      params: { maxSteps: AGENT_MAX_STEPS },
      context: { strategy: expect.any(String), windowTokens: expect.any(Number) },
    })

    // 3) 时间线：用户消息 → 工具调用 → 工具结果 → 计划事件 → 助手文本 → 每步用量
    const page = await timelines.list({ conversationId: result.conversationId, page: 1, size: 100 })
    const kinds = page.items.map((item) => item.kind)
    expect(kinds).toContain(TimelineKind.Text)
    expect(kinds).toContain(TimelineKind.ToolCall)
    expect(kinds).toContain(TimelineKind.ToolResult)
    expect(kinds).toContain(TimelineKind.Plan)
    expect(kinds).toContain(TimelineKind.Step)

    const toolCall = page.items.find((item) => item.kind === TimelineKind.ToolCall)
    expect(toolCall?.toolKey).toBe(MOCK_PLAN_CREATE_TOOL)
    // **入参完整落库**（提交的清单与 mock 给定的一字不差）+ 引擎注入的必填 `reason`（设计 §5.18）
    expect(toolCall?.payload?.input).toEqual({ ...MOCK_PLAN_INITIAL, reason: MOCK_REASON })

    const toolResult = page.items.find((item) => item.kind === TimelineKind.ToolResult)
    // **出参完整落库、不裁剪**：整份清单 + 摘要都在
    expect(toolResult?.payload?.output).toMatchObject({
      goal: MOCK_PLAN_INITIAL.goal,
      revision: 1,
      tasks: MOCK_PLAN_INITIAL.tasks,
    })
    expect((toolResult?.payload?.output as { summary?: string }).summary).toContain('共 2 项')
    expect(toolResult?.state).toBe('output-available')

    // 4) 计划落成 `plan` 事件（当前计划 = 最后一条 plan 事件）
    const planRow = page.items.find((item) => item.kind === TimelineKind.Plan)
    expect(planRow?.payload).toEqual({
      goal: MOCK_PLAN_INITIAL.goal,
      revision: 1,
      tasks: MOCK_PLAN_INITIAL.tasks,
    })
    expect(planRow!.seq).toBeGreaterThan(toolResult!.seq)

    // 5) 步级用量落在 step 行（不是塞进 runs）
    const stepRows = page.items.filter((item) => item.kind === TimelineKind.Step)
    expect(stepRows.length).toBe(result.stepCount)
    expect(stepRows[0].usage).toMatchObject({ inputTokens: expect.any(Number) })

    // 6) 会话累计与标题：标题来自**首轮结束后那次隔离的命名调用**（不是首条消息的截断版）
    const conversation = await conversations.detail(USER, { conversationId: result.conversationId })
    expect(conversation.turnCount).toBe(1)
    expect(conversation.totalTokens).toBeGreaterThan(0)
    expect(conversation.title).toBe(MOCK_TITLE_TEXT)
  })

  it('同一会话并发：已有进行中的一轮 → 3306（真相在数据库的唯一索引）', async () => {
    const first = await chat.chat(USER, { message: '第一轮' })
    createdConversationIds.push(first.conversationId)

    // 手动插一条"进行中"的运行，模拟另一路请求已在跑
    const running = await runs.create({
      conversationId: first.conversationId,
      agentKey: DEFAULT_AGENT_KEY,
      status: RunStatus.Running,
    })

    await expect(
      chat.chat(USER, { conversationId: first.conversationId, message: '第二轮' }),
    ).rejects.toMatchObject({ code: AppErrorCodes.ConversationBusy })

    // 收尾这条占位运行，避免影响后续断言
    await runs.finish(running.id, { status: RunStatus.Canceled })
  })

  it('会话第 2 轮：历史被带进上下文（模型确实收到了上一轮内容）', async () => {
    const first = await chat.chat(USER, { message: '记住：我叫小王' })
    createdConversationIds.push(first.conversationId)
    await chat.chat(USER, { conversationId: first.conversationId, message: '我叫什么？' })

    // 最后一次模型请求里应当包含第一轮的用户消息（上下文真的带上了）
    const lastRequest = mock.requests.at(-1)!
    expect(JSON.stringify(lastRequest.messages)).toContain('记住：我叫小王')
    // 且请求里带着工具定义（能力边界由授权的工具决定：业务工具为空，只有运行时能力）
    expect(JSON.stringify(lastRequest.tools)).toContain(MOCK_PLAN_CREATE_TOOL)

    /**
     * **模型真的被要求填 reason**（设计 §5.18）：请求体里的工具定义必须把 `reason` 写进 `required`。
     *
     * 这是"引擎级注入"在**模型侧**的端到端证据：模型不是靠提示词"记得"要写，
     * 而是工具的参数契约里就有这个必填字段。
     */
    const toolDefinitions = lastRequest.tools as Array<{
      function: { name: string; parameters: { properties: Record<string, unknown>; required: string[] } }
    }>
    const planTool = toolDefinitions.find((tool) => tool.function.name === MOCK_PLAN_CREATE_TOOL)
    expect(planTool?.function.parameters.required).toContain(TOOL_CALL_REASON_FIELD)
    expect(planTool?.function.parameters.properties[TOOL_CALL_REASON_FIELD]).toMatchObject({
      type: 'string',
      minLength: TOOL_CALL_REASON_MIN,
      maxLength: TOOL_CALL_REASON_MAX,
    })

    const conversation = await conversations.detail(USER, { conversationId: first.conversationId })
    expect(conversation.turnCount).toBe(2)
  })

  it('命令执行：模型调 run-command → 真跑一条跨平台命令，入参出参完整落库', async () => {
    const result = await chat.chat(USER, { message: `${MOCK_COMMAND_MARKER} 跑一下看看这台机器的环境` })
    createdConversationIds.push(result.conversationId)

    expect(result.status).toBe(RunStatus.Succeeded)
    expect(result.toolCallCount).toBe(1)

    const page = await timelines.list({ conversationId: result.conversationId, page: 1, size: 100 })
    const toolCall = page.items.find((item) => item.kind === TimelineKind.ToolCall)
    expect(toolCall?.toolKey).toBe(MOCK_COMMAND_TOOL)
    // 入参完整落库：就是模型写的那条命令（外加引擎注入的必填 `reason`）
    expect(toolCall?.payload?.input).toEqual({ command: MOCK_COMMAND, reason: MOCK_REASON })

    // 出参完整落库：真的跑了（退出码 0、stdout 里有输出、shell 按当前平台解析）
    const toolResult = page.items.find((item) => item.kind === TimelineKind.ToolResult)
    const output = toolResult?.payload?.output as Record<string, unknown>
    expect(output.ok).toBe(true)
    expect(output.exitCode).toBe(0)
    expect(String(output.stdout)).toContain(MOCK_COMMAND_OUTPUT)
    expect(output.shell).toBe(resolveShell(process.platform))
    expect(output.timedOut).toBe(false)
    expect(output.truncated).toBe(false)
    expect(toolResult?.state).toBe('output-available')
  })

  /**
   * **这个特性的价值所在**（设计 §5.18）：模型漏写 `reason` → 被拒 → 模型拿到明确话术 → 改正后成功。
   *
   * 端到端验三件事：
   * 1. 拒绝**不炸整轮**（失败是结论，模型还能继续）；
   * 2. 拒绝话术**点名 reason**（模型据此才知道要补什么）；
   * 3. 改正后的那次调用**带着理由落进时间线**（审计查得到"这次为什么调它"）。
   */
  it('漏写 reason 被拒 → 模型改正后成功（纪律闭环）', async () => {
    const result = await chat.chat(USER, {
      message: `${MOCK_NO_REASON_MARKER} 跑一下看看这台机器的环境`,
    })
    createdConversationIds.push(result.conversationId)

    // 整轮照样成功（拒绝是结论，不是崩溃）
    expect(result.status).toBe(RunStatus.Succeeded)

    const page = await timelines.list({ conversationId: result.conversationId, page: 1, size: 100 })
    const rows = page.items.filter((item) => item.kind === TimelineKind.ToolResult)

    // 1) 漏写 reason 的那次被拒：结论里明确写着"要说明 reason"
    const rejected = rows.find(
      (item) => (item.payload?.output as Record<string, unknown> | undefined)?.error === true,
    )
    expect(rejected, '漏写 reason 的那次调用应当被拒').toBeDefined()
    expect(JSON.stringify(rejected?.payload ?? {})).toContain('reason')

    // 2) 改正后那次成功：命令真的跑了（两条结果里只有一条带 ok）
    const succeeded = rows.find(
      (item) => (item.payload?.output as Record<string, unknown> | undefined)?.ok === true,
    )
    expect(succeeded, '改正后应当成功').toBeDefined()
    expect(String((succeeded?.payload?.output as Record<string, unknown>)?.stdout)).toContain(
      MOCK_COMMAND_OUTPUT,
    )
    expect(rows).toHaveLength(2)

    // 3) 落库的入参里带着模型改正后写的理由（引用同一份常量，改文案不会假红）
    const calls = page.items.filter((item) => item.kind === TimelineKind.ToolCall)
    const retried = calls.find(
      (item) => (item.payload?.input as { reason?: string } | undefined)?.reason === MOCK_NO_REASON_FIXED,
    )
    expect(retried, '改正后的那次调用应当带着 reason 落库').toBeDefined()
  })

  it('首轮结束后用模型起名：≤10 字，且与当前 agent 上下文**完全隔离**', async () => {
    const before = mock.requests.length
    const result = await chat.chat(USER, { message: '帮我看看最近有哪些待办' })
    createdConversationIds.push(result.conversationId)

    // 1) 标题来自那次命名调用（首条消息那版 12 字只是兜底，被模型名覆盖）
    const conversation = await conversations.detail(USER, { conversationId: result.conversationId })
    expect(conversation.title).toBe(MOCK_TITLE_TEXT)
    expect(Array.from(conversation.title).length).toBeLessThanOrEqual(10)

    // 2) 命名调用**确实发生过**，且能从请求里认出它：唯一不带工具的请求
    const titleRequests = mock.requests
      .slice(before)
      .filter((body) => !Array.isArray(body.tools) || body.tools.length === 0)
    expect(titleRequests).toHaveLength(1)
    const titleBody = titleRequests[0]
    const serialized = JSON.stringify(titleBody.messages)

    // 3) 隔离性（这条是"完全隔离"的硬证据）：只有命名指令 + 这一轮的记录，
    //    **没有** agent 的系统提示词（工具清单 / 通用约定 / 角色约定），也**没有**工具定义
    expect(serialized).toContain('会话命名助手')
    expect(serialized).not.toContain('可用工具')
    expect(serialized).not.toContain('通用约定')
    expect(serialized).not.toContain('本角色的额外约定')
    expect(serialized).toContain('用户：帮我看看最近有哪些待办')
    expect(titleBody.tools ?? []).toEqual([])
  })

  it('用户改过名之后：第二轮结束时不再重命名（人工名字不会被后台冲掉）', async () => {
    const first = await chat.chat(USER, { message: '记住：我叫小王' })
    createdConversationIds.push(first.conversationId)
    await conversations.rename(USER, { conversationId: first.conversationId, title: '人工名字' })

    await chat.chat(USER, { conversationId: first.conversationId, message: '我叫什么？' })

    const conversation = await conversations.detail(USER, { conversationId: first.conversationId })
    expect(conversation.title).toBe('人工名字')
    expect(conversation.turnCount).toBe(2)
  })

  it('系统提示词：**每个会话首轮生成一次**，之后逐字复用（含运行环境段），且只落一条快照', async () => {
    const beforeFirst = mock.requests.length
    const first = await chat.chat(USER, { message: '今天几号？' })
    createdConversationIds.push(first.conversationId)

    const firstTurnRequests = mock.requests.slice(beforeFirst)
    expect(firstTurnRequests.length).toBeGreaterThan(0)
    // 首轮那份里注入了**当前平台**的画像与时间，不是写死的文案
    //（标记用片段的完整标题：正文里另有"命令按运行环境里那个 shell 语法写"这类提法，不能用"运行环境"当标记）
    const firstSystem = String(
      (firstTurnRequests[0]!.messages as Array<{ role: string; content: unknown }>).find(
        (message) => message.role === 'system',
      )?.content ?? '',
    )
    expect(firstSystem).toContain('运行环境（本会话开始时）')
    expect(firstSystem).toContain(describePlatform().label)
    expect(firstSystem).toContain(String(new Date().getFullYear()))

    const beforeSecond = mock.requests.length
    await chat.chat(USER, { conversationId: first.conversationId, message: '那现在呢？' })
    const secondTurnRequests = mock.requests.slice(beforeSecond)
    expect(secondTurnRequests.length).toBeGreaterThan(0)
    const secondSystem = String(
      (secondTurnRequests[0]!.messages as Array<{ role: string; content: unknown }>).find(
        (message) => message.role === 'system',
      )?.content ?? '',
    )

    /**
     * **口径（用户拍板）**：系统提示词每个会话首轮生成一次 —— 第二轮用的就是首轮那一份**逐字相同**
     * （运行环境段仍在里面）。这样前缀缓存整段命中；会话进行中改了提示词模板也不会中途换掉它。
     */
    expect(secondSystem).toBe(firstSystem)

    /** 快照只落一条：不是每轮灌一行（否则"这个会话的系统提示词"会被重复行淹没） */
    const rows = (await db.dataSource.query(
      "SELECT count(*)::int AS count FROM timelines WHERE conversation_id = $1 AND kind = 'system'",
      [first.conversationId],
    )) as Array<{ count: number }>
    expect(rows[0]?.count).toBe(1)
  })
})
