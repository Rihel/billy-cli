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
import { createMastra } from '../src/modules/ai/core/ai.mastra.js'
import { createAgentRegistry } from '../src/modules/ai/core/ai.registry.js'
import { createPromptEngine } from '../src/modules/ai/prompts/index.js'
import { SkillLoader } from '../src/modules/ai/skills/index.js'
import { CreateTodoTool } from '../src/modules/ai/tools/create-todo.tool.js'
import { GetTodoTool } from '../src/modules/ai/tools/get-todo.tool.js'
import { ListTodosTool } from '../src/modules/ai/tools/list-todos.tool.js'
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
import { TodoService } from '../src/modules/todo/todo.service.js'
import {
  MOCK_FINAL_TEXT,
  MOCK_TOOL_INPUT,
  type MockModelServer,
  startMockModelServer,
} from './helpers/mock-model-server.js'

/**
 * 对话链路端到端测试：**假模型（本地 mock）+ 真实数据库**，不需要任何外部密钥。
 *
 * 验证的是"真的跑通一条链路"：
 *   建 run → 组装上下文 → 落用户消息 → 模型调工具（真实执行 TodoService）→ 落时间线（入参出参完整）
 *   → 收尾（消耗 / 步数 / 轮数 / 标题）→ 数据可查、可复盘。
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
  if (!db.dataSource.isInitialized) throw new Error('数据库初始化失败')

  conversationRepo = new ConversationRepository(db)
  runs = new RunRepository(db)
  timelines = new TimelineRepository(db)

  // 工具 bean：需要一个可用的 TodoService（注入 Db；它内部用事务管理器，用 Db 门面包一层）
  const todoService = new TodoService(
    {
      async page() {
        return {
          items: [
            {
              id: 't1',
              title: '写设计文档',
              description: null,
              completed: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          total: 1,
          page: 1,
          size: 3,
        }
      },
      async get() {
        return {
          id: 't1',
          title: '写设计文档',
          description: null,
          completed: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      },
      async create() {
        return {
          id: 't2',
          title: '新建的待办',
          description: null,
          completed: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      },
    } as never,
    silentLogger,
  )

  // 这份配置要能用"默认模型"造子 agent（跑不跑是另一回事）：baseURL 缺了会退到 model router 报错
  const config = { ...TEST_CONFIG, baseURL: mock.baseURL } as never
  const runner = new AgentRunner(runs, timelines, config, silentLogger)
  const toolBuilder = new ToolBuilder(
    [new ListTodosTool(todoService), new GetTodoTool(todoService), new CreateTodoTool(todoService)],
    // core bean（规划 + 子 agent）：与 `ai.module.ts` 的装配口径一致
    [new PlannerCore(), new SubAgentCore(runner, silentLogger)],
  )
  const registry = createAgentRegistry(
    createAgentDefinitions(createPromptEngine(), toolBuilder),
    DEFAULT_AGENT_KEY,
  )

  const skillLoader = new SkillLoader(silentLogger)
  const mastra = await createMastra({
    model: { model: 'mock/mock-model', apiKey: 'test-key', baseURL: mock.baseURL },
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
      params: { maxSteps: 5 },
      context: { strategy: expect.any(String), windowTokens: expect.any(Number) },
    })

    // 3) 时间线：用户消息 → 工具调用 → 工具结果 → 助手文本 → 每步用量
    const page = await timelines.list({ conversationId: result.conversationId, page: 1, size: 100 })
    const kinds = page.items.map((item) => item.kind)
    expect(kinds).toContain(TimelineKind.Text)
    expect(kinds).toContain(TimelineKind.ToolCall)
    expect(kinds).toContain(TimelineKind.ToolResult)
    expect(kinds).toContain(TimelineKind.Step)

    const toolCall = page.items.find((item) => item.kind === TimelineKind.ToolCall)
    expect(toolCall?.toolKey).toBe('list-todos')
    // **入参完整落库**（与 mock 给定的一致）
    expect(toolCall?.payload?.input).toEqual(MOCK_TOOL_INPUT)

    const toolResult = page.items.find((item) => item.kind === TimelineKind.ToolResult)
    expect(toolResult?.payload?.output).toMatchObject({ total: 1 })
    expect(toolResult?.state).toBe('output-available')

    // 4) 步级用量落在 step 行（不是塞进 runs）
    const stepRows = page.items.filter((item) => item.kind === TimelineKind.Step)
    expect(stepRows.length).toBe(result.stepCount)
    expect(stepRows[0].usage).toMatchObject({ inputTokens: expect.any(Number) })

    // 5) 会话累计与标题（不额外调模型）
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
    // 且请求里带着工具定义（能力边界由授权的工具决定）
    expect(JSON.stringify(lastRequest.tools)).toContain('list-todos')

    const conversation = await conversations.detail(USER, { conversationId: first.conversationId })
    expect(conversation.turnCount).toBe(2)
  })
})
