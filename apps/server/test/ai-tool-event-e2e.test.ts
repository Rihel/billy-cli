import 'dotenv/config'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Db, IdGeneration, RedisStore, setAuditUserProvider } from '@repo/kits'
import { TimelineKind } from '@repo/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConversationEntity } from '../src/database/entities/conversation-entity.js'
import { RunEntity } from '../src/database/entities/run-entity.js'
import { TimelineEntity } from '../src/database/entities/timeline-entity.js'
import { DEFAULT_AGENT_KEY } from '../src/modules/ai/agents/index.js'
import type { AgentDefinition, AgentRegistry } from '../src/modules/ai/agents/types.js'
import { createAgentRegistry } from '../src/modules/ai/agents/registry.js'
import { createPromptEngine } from '../src/modules/ai/core/prompts/index.js'
import { createMastra } from '../src/modules/ai/mastra/ai.mastra.js'
import { toMastraSkills } from '../src/modules/ai/mastra/skill.adapter.js'
import { toMastraTools } from '../src/modules/ai/mastra/tool.adapter.js'
import { SkillLoader } from '../src/modules/ai/core/skills/index.js'
import { ToolGateway } from '../src/modules/ai/core/tools/tool.gateway.js'
import { ToolRegistry } from '../src/modules/ai/core/tools/tool.registry.js'
import { TOOL_KEYS } from '../src/modules/ai/core/tools/tool-keys.js'
import { FileTools } from '../src/modules/ai/files/file.tools.js'
import { WebTools } from '../src/modules/ai/tools/web.tools.js'
import { RunSubAgentTool } from '../src/modules/ai/tools/subagent.tool.js'
import { ReadToolResultTool } from '../src/modules/ai/tools/read-tool-result.tool.js'
import { PlannerStore, PlannerTools } from '../src/modules/ai/tools/planner/index.js'
import { ToolEventDemoTool } from '../src/modules/ai/tools/tool-event-testkit.js'
import { AgentChatService } from '../src/modules/ai/runtime/chat.service.js'
import { AgentRunner } from '../src/modules/ai/runtime/agent-runner.js'
import { AgentTitleService } from '../src/modules/ai/runtime/title.service.js'
import { AgentConversationService } from '../src/modules/ai/runtime/conversation.service.js'
import { ConversationRepository } from '../src/modules/ai/runtime/conversation.repository.js'
import { ContextService } from '../src/modules/ai/runtime/context.service.js'
import { RunRepository } from '../src/modules/ai/runtime/run.repository.js'
import { AgentStreamStore } from '../src/modules/ai/runtime/stream-store.service.js'
import { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'
import { buildToolStackDeps, makeBashTool } from './helpers/ai-tool-stack.js'
import { stubAttachments } from './helpers/attachments.js'
import {
  MOCK_EVENT_LINE,
  MOCK_EVENT_PROGRESS,
  MOCK_EVENTS_MARKER,
  MOCK_EVENTS_TOOL,
  MOCK_FINAL_TEXT,
  type MockModelServer,
  startMockModelServer,
} from './helpers/mock-model-server.js'

/**
 * 工具自定义事件的**端到端**（设计 §5.17）：真实 Mastra + 真实 DB + 真实 Redis + 离线 mock 模型。
 *
 * 这一份是"协议真的通了"的唯一证据，验四件事：
 * 1. 工具执行体调 `ctx.emit(...)` → SSE 里出现 `data-tool-event` part（适配器与 Mastra 都没吃掉它）；
 * 2. `mode='state'` 的块**带的 id 同一份**（前端按 id 归并成最新快照）；
 * 3. `mode='stream'` 的块**不带 id**（逐条追加）；
 * 4. 事件**不落库**（时间线里没有它们）—— 过程走流、结论（出参）才落库，与 `data-sub-agent*` 同口径。
 *
 * 演示工具组在 `src/modules/ai/tools/tool-event-testkit.ts`（测试专用，不进 `AGENT_TOOL_GROUPS`）。
 */

const USER = 'user_tool_evt_e2e'
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/15'

const silentLogger = {
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

/** 测试配置：字段给全（`undefined` 进 setTimeout 会立刻超时），与流式 e2e 同一口径 */
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
  commandEnabled: true,
  commandTimeoutMs: 5_000,
  commandMaxOutputBytes: 64 * 1024,
} as never

let db: Db
let redis: RedisStore
let mock: MockModelServer
let chat: AgentChatService
let conversations: AgentConversationService
let timelines: TimelineRepository
let http: Server
let httpBase: string
const createdConversationIds: string[] = []

/** SSE 原文里按 part 类型取出来（宽容解析：只认 JSON 得动的 `data:` 帧） */
const partsOfType = (
  text: string,
  type: string,
): Array<{ id?: string; data: Record<string, unknown> }> =>
  text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: ') && frame.includes(`"${type}"`))
    .map((frame) => JSON.parse(frame.slice(6)) as { id?: string; data: Record<string, unknown> })

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

  redis = new RedisStore(
    { url: REDIS_URL, keyPrefix: 'aitevent:' } as never,
    new IdGeneration(),
    silentLogger,
  )
  await redis.onApplicationBootstrap()
  const streamStore = new AgentStreamStore(redis, silentLogger)

  const conversationRepo = new ConversationRepository(db)
  const runs = new RunRepository(db, { changed: async () => {} })
  timelines = new TimelineRepository(db)

  const config = { ...TEST_CONFIG, baseURL: mock.baseURL } as never
  const deps = buildToolStackDeps()
  const gateway = new ToolGateway(deps.config, silentLogger, [], deps.clock)
  let toolRegistry: ToolRegistry
  const moduleRefPort = { get: () => toolRegistry } as never
  const runner = new AgentRunner(runs, timelines, config, silentLogger, deps.metas, moduleRefPort)

  const plannerStore = new PlannerStore(timelines)
  toolRegistry = new ToolRegistry(
    [
      makeBashTool(silentLogger),
      new WebTools(silentLogger as never),
      new FileTools({} as never, { enabled: true } as never),
      new RunSubAgentTool(runner, silentLogger),
      new PlannerTools(plannerStore),
      new ReadToolResultTool(deps.results, deps.counter, deps.caps),
      // 测试专用：只在这一份测试里挂上去（生产 `AGENT_TOOL_GROUPS` 不含它）
      new ToolEventDemoTool(),
    ],
    gateway,
    deps.config,
  )

  /**
   * 测试用的 agent 声明：**不改生产 `assistant.agent.ts`**，在这里现造一份"多授权一个演示工具"的定义。
   *
   * 与生产同一套装配口径：`tools` 是实际授权清单，提示词由 `registry.describe()` 渲染
   * （所以"写进提示词的"与"真正挂上去的"仍是同一份）。
   */
  const prompts = createPromptEngine()
  const tools = [
    TOOL_KEYS.planCreate,
    TOOL_KEYS.planReorder,
    TOOL_KEYS.planComplete,
    TOOL_KEYS.planDelete,
    TOOL_KEYS.runSubAgent,
    TOOL_KEYS.bash,
    TOOL_KEYS.readToolResult,
    MOCK_EVENTS_TOOL,
  ]
  const definition: AgentDefinition = {
    key: DEFAULT_AGENT_KEY,
    name: '通用助手（事件 e2e）',
    description: '只用于工具自定义事件的端到端测试',
    tools,
    skills: [],
    instructions: prompts.render('assistant', {
      agentKey: DEFAULT_AGENT_KEY,
      agentName: '通用助手（事件 e2e）',
      tools: toolRegistry.describe(tools),
    }),
  }
  const registry: AgentRegistry = createAgentRegistry([definition], DEFAULT_AGENT_KEY)

  const skillLoader = new SkillLoader(silentLogger)
  const mastra = await createMastra({
    resolveModel: () => ({ id: 'mock/mock-model', url: mock.baseURL, apiKey: 'test-key' }),
    definitions: registry.all(),
    resolveTools: (keys) => toMastraTools(toolRegistry.toolbox(keys), silentLogger),
    resolveSkills: async (names) => toMastraSkills(await skillLoader.resolve(names)),
  })

  const modelsStub = {
    resolveForRuntime: async () => ({
      id: 'model_mock',
      modelRef: 'mock/mock-model',
      modelKey: 'mock-model',
      displayName: 'Mock 模型',
      providerKind: 'openai-compatible',
      baseURL: mock.baseURL,
      apiKey: 'test-key',
      contextWindow: null,
    }),
  } as never

  conversations = new AgentConversationService(
    conversationRepo,
    runs,
    timelines,
    registry,
    silentLogger,
  )
  const context = new ContextService(timelines, config, silentLogger)
  // 附件替身：e2e 不带附件，但构造器是位置参数，少一个会让后面整体错位
  const chatAttachments = stubAttachments(silentLogger)

  chat = new AgentChatService(
    mastra,
    registry,
    config,
    conversations,
    conversationRepo,
    runs,
    timelines,
    context,
    chatAttachments,
    streamStore,
    toolRegistry,
    deps.metas,
    skillLoader,
    modelsStub,
    silentLogger,
    prompts,
    new AgentTitleService(timelines, prompts, silentLogger),
  )

  http = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
        string,
        unknown
      >
      void chat.chatStream(USER, body as never, res).catch((_error: unknown) => {
        if (!res.writableEnded) res.statusCode = 500
        res.end()
      })
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  httpBase = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  setAuditUserProvider(() => USER)
})

afterAll(async () => {
  setAuditUserProvider(undefined)
  await db.dataSource.query(
    'DELETE FROM timelines WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = $1)',
    [USER],
  )
  await db.dataSource.query(
    'DELETE FROM runs WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = $1)',
    [USER],
  )
  await db.dataSource.query('DELETE FROM conversations WHERE user_id = $1', [USER])
  await new Promise<void>((resolve) => http.close(() => resolve()))
  await redis.onApplicationShutdown()
  await db.onApplicationShutdown()
  await mock.close()
})

describe('工具自定义事件端到端（mock 模型 + 真实 DB + 真实 Redis）', () => {
  it('工具发的 data-tool-event 进 SSE：状态块带稳定 id、流水块不带 id、事件不落库', async () => {
    const response = await fetch(`${httpBase}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: `发几个事件看看 ${MOCK_EVENTS_MARKER}` }),
    })
    const text = await response.text()
    expect(response.status).toBe(200)

    const events = partsOfType(text, 'data-tool-event')
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events.every((part) => part.data.toolKey === MOCK_EVENTS_TOOL)).toBe(true)
    // part 自带描述字段（前端认不出事件也能兜底渲染）
    expect(events.every((part) => typeof part.data.eventTitle === 'string')).toBe(true)
    expect(events.every((part) => part.data.agentKey === DEFAULT_AGENT_KEY)).toBe(true)

    // ① 状态块：同一事件的两块**共用同一个 id**（前端按 id 归并 → 只留最新快照）
    const stateParts = events.filter((part) => part.data.event === 'progress')
    expect(stateParts).toHaveLength(2)
    expect(stateParts.every((part) => typeof part.id === 'string' && part.id.length > 0)).toBe(true)
    expect(new Set(stateParts.map((part) => part.id)).size).toBe(1)
    expect(stateParts.map((part) => part.data.seq)).toEqual([0, 1])
    // 后发的那一块带着最终状态（"后者覆盖前者"要的就是这个）
    expect(stateParts[1].data.payload).toEqual(MOCK_EVENT_PROGRESS)

    // ② 流水块：**不带 id**，一块一条（AI SDK 按 id 归并，带 id 会互相覆盖）
    const lineParts = events.filter((part) => part.data.event === 'line')
    expect(lineParts).toHaveLength(1)
    expect(lineParts[0].id).toBeUndefined()
    expect(lineParts[0].data.payload).toBe(MOCK_EVENT_LINE)
    expect(lineParts[0].data.mode).toBe('stream')

    // ③ 未声明的事件被丢弃：SSE 里没有它
    expect(events.some((part) => part.data.event === 'not-declared')).toBe(false)

    // ④ 事件**不落库**：时间线里只有工具调用 / 结果 / 文本，没有事件行
    const conversationId = /"conversationId":"([^"]+)"/.exec(text)?.[1]
    expect(conversationId).toBeTruthy()
    if (conversationId) createdConversationIds.push(conversationId)
    const page = await timelines.list({ conversationId: conversationId!, page: 1, size: 200 })
    const kinds = page.items.map((item) => item.kind)
    expect(kinds).toContain(TimelineKind.ToolCall)
    expect(kinds).toContain(TimelineKind.ToolResult)
    expect(
      page.items.some((item) => JSON.stringify(item.payload ?? {}).includes('"data-tool-event"')),
    ).toBe(false)

    // ⑤ 出参照常回到模型并被采纳（事件失败 / 未声明都不影响工具结论）
    const assistantText = page.items
      .filter((item) => item.kind === TimelineKind.Text && item.role === 'assistant')
      .map((item) => String(item.payload?.text ?? ''))
      .join('')
    expect(assistantText).toContain(MOCK_FINAL_TEXT)
    expect(conversationId).toBeTruthy()
  }, 30_000)
})
