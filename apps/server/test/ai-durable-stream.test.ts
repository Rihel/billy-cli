import 'dotenv/config'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { InMemoryStore } from '@mastra/core/storage'
import { CommandRunner, Db, IdGeneration, RedisStore, setAuditUserProvider } from '@repo/kits'
import { RunStatus, TimelineKind } from '@repo/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConversationEntity } from '../src/database/entities/conversation-entity.js'
import { RunEntity } from '../src/database/entities/run-entity.js'
import { TimelineEntity } from '../src/database/entities/timeline-entity.js'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from '../src/modules/ai/agents/index.js'
import { createMastra } from '../src/modules/ai/core/ai.mastra.js'
import { createAgentRegistry } from '../src/modules/ai/core/ai.registry.js'
import { PlannerCore } from '../src/modules/ai/core/planner.core.js'
import { SubAgentCore } from '../src/modules/ai/core/subagent.core.js'
import { CommandCore } from '../src/modules/ai/core/command.core.js'
import { createPromptEngine } from '../src/modules/ai/prompts/index.js'
import { AgentTitleService } from '../src/modules/ai/runtime/title.service.js'
import { AgentChatService } from '../src/modules/ai/runtime/chat.service.js'
import { AgentConversationService } from '../src/modules/ai/runtime/conversation.service.js'
import { ConversationRepository } from '../src/modules/ai/runtime/conversation.repository.js'
import { ContextService } from '../src/modules/ai/runtime/context.service.js'
import { AgentRunner } from '../src/modules/ai/runtime/agent-runner.js'
import { RunRepository } from '../src/modules/ai/runtime/run.repository.js'
import { AgentStreamStore } from '../src/modules/ai/runtime/stream-store.service.js'
import { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'
import { SkillLoader } from '../src/modules/ai/skills/index.js'
import { ToolBuilder } from '../src/modules/ai/tools/tool.builder.js'
import {
  MOCK_FINAL_TEXT,
  MOCK_TODO_TOOL,
  type MockModelServer,
  startMockModelServer,
} from './helpers/mock-model-server.js'

/**
 * **可恢复执行（`durable: true`）下的流式收尾**回归。
 *
 * 踩过的坑（用户看到的现象是"回答都流出来了，但这一轮却算失败、会话也没有轮次"）：
 * 打开 durable 后 `agent.stream()` 返回的是 `AgentThreadRun` 包装对象
 * （`{ output, fullStream, runId, threadId, resourceId, cleanup }`），真正的
 * `MastraModelOutput` 在 **`output` 字段里**。收尾处直接读 `output.steps` 得到 `undefined`，
 * 于是 `steps.entries()` 抛 `Cannot read properties of undefined (reading 'entries')`，
 * 整轮被判成 failed（`stepCount=0`、用量为空、会话累计与标题都不写）。
 *
 * 这个文件就是那条路径的守卫：**durable 打开**跑一轮完整问答，断言
 * 运行成功、步骤行与用量都落了库、会话轮次与标题都更新了。
 *
 * 与 `ai-stream-e2e.test.ts` 的分工：那边覆盖 SSE 协议 / 停止 / 补发（`durable: false`），
 * 这边只盯 durable 的收尾口径，故意不混在一起（durable 每步落快照，跑一轮明显更慢）。
 */

const USER = 'user_ai_durable'
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/14'

const silentLogger = {
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

let db: Db
let redis: RedisStore
let mock: MockModelServer
let chat: AgentChatService
let conversations: AgentConversationService
let runs: RunRepository
let timelines: TimelineRepository
let http: Server
let httpBase: string
const createdConversationIds: string[] = []

/** 测试配置：与 `ai-stream-e2e.test.ts` 同口径，**只有 durableEnabled 不一样** */
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
  durableEnabled: true,
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
} as never

const postStream = async (body: Record<string, unknown>): Promise<string> => {
  const response = await fetch(`${httpBase}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.text()
}

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

  redis = new RedisStore(
    { url: REDIS_URL, keyPrefix: 'aidurable:' } as never,
    new IdGeneration(),
    silentLogger,
  )
  await redis.onApplicationBootstrap()
  const streamStore = new AgentStreamStore(redis, silentLogger)

  const conversationRepo = new ConversationRepository(db)
  runs = new RunRepository(db)
  timelines = new TimelineRepository(db)

  const config = { ...TEST_CONFIG, baseURL: mock.baseURL } as never
  const runner = new AgentRunner(runs, timelines, config, silentLogger)
  const skillLoader = new SkillLoader(silentLogger)
  const toolBuilder = new ToolBuilder([], [
    new PlannerCore(timelines),
    new SubAgentCore(runner, silentLogger),
    // 命令执行 core：与 `ai.module.ts` 的装配口径一致（assistant 已授权 run-command）
    new CommandCore(new CommandRunner(), config, silentLogger),
  ])
  const registry = createAgentRegistry(
    createAgentDefinitions(createPromptEngine(), toolBuilder),
    DEFAULT_AGENT_KEY,
  )
  const mastra = await createMastra({
    resolveModel: () => ({ id: 'mock/mock-model', url: mock.baseURL, apiKey: 'test-key' }),
    definitions: registry.all(),
    resolveTools: (keys) => toolBuilder.build(keys),
    resolveSkills: (names) => skillLoader.resolve(names),
    // durable 的每步快照必须有地方落：测试用 Mastra 自带的内存 store（不碰我们的 workflows 表）
    storage: new InMemoryStore() as never,
    durableAgents: true,
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
    streamStore,
    toolBuilder,
    skillLoader,
    modelsStub,
    silentLogger,
    createPromptEngine(),
    new AgentTitleService(timelines, createPromptEngine(), silentLogger),
  )

  http = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
        string,
        unknown
      >
      void chat.chatStream(USER, body as never, res).catch(() => {
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
  await new Promise<void>((resolve) => http.close(() => resolve()))
  await redis.onApplicationShutdown()
  await db.onApplicationShutdown()
  await mock.close()
})

describe('可恢复执行（durable）下的流式收尾', () => {
  it('durable 包装对象也能读出步骤与用量：整轮成功、步骤行落库、会话轮次与标题更新', async () => {
    const text = await postStream({ message: '帮我看看待办' })
    // 响应正常收尾（[DONE] 是"服务端已落好终态"的信号）
    expect(text).toContain('[DONE]')
    // 用量在**收尾落库之后、[DONE] 之前**下发（会话页的用量条就靠它；缺失时前端显示"—"）
    const usageFrame = text
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line.includes('"data-run-usage"'))
    expect(usageFrame).toHaveLength(1)
    const usageData = (JSON.parse(usageFrame[0].slice(6)) as { data: { usage: unknown } }).data
    expect(usageData.usage).toBeTruthy()
    expect(text.indexOf('data-run-usage')).toBeLessThan(text.indexOf('[DONE]'))

    const list = await conversations.list(USER, { page: 1, size: 1, includeDeleted: false })
    const conversationId = list.items[0].id
    createdConversationIds.push(conversationId)

    // ① 运行必须是成功 —— 这条就是踩过的坑：早先 durable 下这里是 failed（3302）
    const runRows = await db.dataSource.query<
      { id: string; status: string; step_count: number; usage: unknown; error_message: unknown }[]
    >('SELECT id, status, step_count, usage, error_message FROM runs WHERE conversation_id = $1', [
      conversationId,
    ])
    expect(runRows).toHaveLength(1)
    expect(runRows[0].status).toBe(RunStatus.Succeeded)
    expect(runRows[0].error_message).toBeNull()
    // ② 步骤数与用量都读出来了（读不到包装里的 output 时这两个都会是 0 / null）
    expect(runRows[0].step_count).toBeGreaterThan(0)
    expect(runRows[0].usage).toBeTruthy()

    // ③ 时间线：正文、工具往返、每步用量行都在
    const page = await timelines.list({ conversationId, page: 1, size: 100 })
    const kinds = page.items.map((item) => item.kind)
    expect(kinds).toContain(TimelineKind.Text)
    expect(kinds).toContain(TimelineKind.ToolCall)
    expect(kinds).toContain(TimelineKind.ToolResult)
    expect(kinds).toContain(TimelineKind.Step)
    expect(page.items.find((item) => item.kind === TimelineKind.ToolResult)?.toolKey).toBe(
      MOCK_TODO_TOOL,
    )
    const assistantText = page.items
      .filter((item) => item.kind === TimelineKind.Text && item.role === 'assistant')
      .map((item) => String(item.payload?.text ?? ''))
      .join('')
    expect(assistantText).toContain(MOCK_FINAL_TEXT)

    // ④ 会话轮次与标题都被更新（它们只在收尾成功那条路径上写）
    const conversation = await conversations.detail(USER, { conversationId })
    expect(conversation.turnCount).toBeGreaterThan(0)
    expect(conversation.title.length).toBeGreaterThan(0)
  }, 60_000)
})
