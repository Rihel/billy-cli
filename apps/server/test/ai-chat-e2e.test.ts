import 'dotenv/config'
import { Db, setAuditUserProvider } from '@repo/kits'
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
import { AGENT_MAX_STEPS } from '../src/modules/ai/core/ai.constants.js'
import { createMastra } from '../src/modules/ai/core/ai.mastra.js'
import { createAgentRegistry } from '../src/modules/ai/core/ai.registry.js'
import { createPromptEngine } from '../src/modules/ai/prompts/index.js'
import { SkillLoader } from '../src/modules/ai/skills/index.js'
import { ToolBuilder } from '../src/modules/ai/tools/tool.builder.js'
import { PlannerCore } from '../src/modules/ai/core/planner.core.js'
import { SubAgentCore } from '../src/modules/ai/core/subagent.core.js'
import { AgentRunner } from '../src/modules/ai/runtime/agent-runner.js'
import { AgentChatService } from '../src/modules/ai/runtime/chat.service.js'
import { AgentConversationService } from '../src/modules/ai/runtime/conversation.service.js'
import { ConversationRepository } from '../src/modules/ai/runtime/conversation.repository.js'
import { ContextService } from '../src/modules/ai/runtime/context.service.js'
import { RunRepository } from '../src/modules/ai/runtime/run.repository.js'
import { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'
import {
  MOCK_FINAL_TEXT,
  MOCK_TODO_INITIAL,
  MOCK_TODO_TOOL,
  type MockModelServer,
  startMockModelServer,
} from './helpers/mock-model-server.js'

/**
 * 对话链路端到端测试：**假模型（本地 mock）+ 真实数据库**，不需要任何外部密钥。
 *
 * 验证的是"真的跑通一条链路"：
 *   建 run → 组装上下文 → 落用户消息 → 模型调工具（真实执行 core bean 的 `todo-write`）
 *   → 落时间线（入参出参完整、计划落成 `plan` 事件）→ 收尾（消耗 / 步数 / 轮数 / 标题）
 *   → 数据可查、可复盘。
 *
 * AI 模块已与业务模块解耦：这里**没有业务工具 bean**（`AGENT_TOOLS` 为空数组），
 * 工具池只有 core bean 交出的运行时能力（规划 + 子 agent）。
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
  const runner = new AgentRunner(runs, timelines, config, silentLogger)
  const toolBuilder = new ToolBuilder(
    // 业务工具**为空**：AI 模块与业务模块解耦后的常态（`AGENT_TOOLS` 是扩展点）
    [],
    // core bean（规划 + 子 agent）：与 `ai.module.ts` 的装配口径一致
    [new PlannerCore(timelines), new SubAgentCore(runner, silentLogger)],
  )
  const registry = createAgentRegistry(
    createAgentDefinitions(createPromptEngine(), toolBuilder),
    DEFAULT_AGENT_KEY,
  )

  const skillLoader = new SkillLoader(silentLogger)
  const mastra = await createMastra({
    // 模型改为"按 requestContext 解析"的动态参数；这些测试不验证选模型，给恒定 mock 模型
    resolveModel: () => ({ id: 'mock/mock-model', url: mock.baseURL, apiKey: 'test-key' }),
    definitions: registry.all(),
    resolveTools: (keys) => toolBuilder.build(keys),
    resolveSkills: (names) => skillLoader.resolve(names),
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
    toolBuilder,
    skillLoader,
    modelsStub,
    silentLogger,
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
    expect(toolCall?.toolKey).toBe(MOCK_TODO_TOOL)
    // **入参完整落库**（提交的完整清单与 mock 给定的一字不差）
    expect(toolCall?.payload?.input).toEqual(MOCK_TODO_INITIAL)

    const toolResult = page.items.find((item) => item.kind === TimelineKind.ToolResult)
    // **出参完整落库、不裁剪**：整份清单 + 摘要都在
    expect(toolResult?.payload?.output).toMatchObject({
      goal: MOCK_TODO_INITIAL.goal,
      revision: 1,
      tasks: MOCK_TODO_INITIAL.tasks,
    })
    expect((toolResult?.payload?.output as { summary?: string }).summary).toContain('共 2 项')
    expect(toolResult?.state).toBe('output-available')

    // 4) 计划落成 `plan` 事件（当前计划 = 最后一条 plan 事件）
    const planRow = page.items.find((item) => item.kind === TimelineKind.Plan)
    expect(planRow?.payload).toEqual({
      goal: MOCK_TODO_INITIAL.goal,
      revision: 1,
      tasks: MOCK_TODO_INITIAL.tasks,
    })
    expect(planRow!.seq).toBeGreaterThan(toolResult!.seq)

    // 5) 步级用量落在 step 行（不是塞进 runs）
    const stepRows = page.items.filter((item) => item.kind === TimelineKind.Step)
    expect(stepRows.length).toBe(result.stepCount)
    expect(stepRows[0].usage).toMatchObject({ inputTokens: expect.any(Number) })

    // 6) 会话累计与标题（不额外调模型）
    const conversation = await conversations.detail(USER, { conversationId: result.conversationId })
    expect(conversation.turnCount).toBe(1)
    expect(conversation.totalTokens).toBeGreaterThan(0)
    expect(conversation.title).toBe('帮我看看最近有哪些待办')
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
    expect(JSON.stringify(lastRequest.tools)).toContain(MOCK_TODO_TOOL)

    const conversation = await conversations.detail(USER, { conversationId: first.conversationId })
    expect(conversation.turnCount).toBe(2)
  })
})
