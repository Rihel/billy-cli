import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { Db, setAuditUserProvider } from '@repo/kits'
import { AiProviderKind, RunStatus } from '@repo/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AiModelEntity } from '../src/database/entities/ai-model-entity.js'
import { AiProviderEntity } from '../src/database/entities/ai-provider-entity.js'
import { ConversationEntity } from '../src/database/entities/conversation-entity.js'
import { RunEntity } from '../src/database/entities/run-entity.js'
import { TimelineEntity } from '../src/database/entities/timeline-entity.js'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from '../src/modules/ai/agents/index.js'
import { createMastra } from '../src/modules/ai/core/ai.mastra.js'
import { createAgentRegistry } from '../src/modules/ai/core/ai.registry.js'
import { readAgentRuntime } from '../src/modules/ai/core/ai.core.types.js'
import { decideModelForMastra } from '../src/modules/ai/core/ai.model-decision.js'
import { PlannerCore } from '../src/modules/ai/core/planner.core.js'
import { SubAgentCore } from '../src/modules/ai/core/subagent.core.js'
import { createPromptEngine } from '../src/modules/ai/prompts/index.js'
import { AgentChatService } from '../src/modules/ai/runtime/chat.service.js'
import { AgentConversationService } from '../src/modules/ai/runtime/conversation.service.js'
import { ConversationRepository } from '../src/modules/ai/runtime/conversation.repository.js'
import { ContextService } from '../src/modules/ai/runtime/context.service.js'
import { AgentRunner } from '../src/modules/ai/runtime/agent-runner.js'
import { RunRepository } from '../src/modules/ai/runtime/run.repository.js'
import { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'
import { SkillLoader } from '../src/modules/ai/skills/index.js'
import { ToolBuilder } from '../src/modules/ai/tools/tool.builder.js'
import {
  AiModelRepository,
  AiModelService,
  AiProviderRepository,
  type AiModelConfig,
} from '../src/modules/ai-model/index.js'
import {
  MOCK_MODEL_LIST,
  type MockModelServer,
  startMockModelServer,
} from './helpers/mock-model-server.js'

/**
 * **"会话页选的模型，真的被用了"** 端到端（真实数据库 + 离线 mock 供应商，不需要外部密钥）。
 *
 * 链条（这也是本轮修的两个坑的守卫）：
 *   `resolveForRuntime(modelId)` → 运行时信封 → `decideModelForMastra`（kind 决定走哪个 SDK）
 *   → Mastra 的模型函数 → mock 收到的 `body.model`。
 *
 * 三条断言各自锁一件事：
 * 1. 选了哪个模型，请求里就是哪个（**不做静默回落**）；
 * 2. 传一个"没配过 / 被禁用"的 modelId → 明确报错，且**一个模型请求都不发**（不烧钱）；
 * 3. 官方适配（DeepSeek kind）**即使库里配了 baseURL 也不传 url**（传了思考字段会整段丢）。
 *    这条是纯函数断言：真打 `api.deepseek.com` 不是测试该干的事。
 */

const TEST_USER = 'user_ai_model_select'
const TEST_SECRET = `test-secret-${randomBytes(8).toString('hex')}`
const TEST_API_KEY = 'sk-test-abcdefgh-abcd'

/** 被选中的那个模型（mock 的 `/models` 列表里就有它，语义上"这家真有这个模型"） */
const SELECTED_MODEL_KEY = 'mock-reasoner'

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
let modelService: AiModelService
let conversations: AgentConversationService
let providerId: string
let selectedModelId: string
let disabledModelId: string

const createdConversationIds: string[] = []

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
} as never

/** mock 收到的**对话请求**（`GET /models` 是同步用的，不算） */
const chatRequests = (): Array<Record<string, unknown>> =>
  mock.requests.filter((request) => request.model !== undefined || Array.isArray(request.messages))

beforeAll(async () => {
  mock = await startMockModelServer()

  db = new Db(
    {
      url: process.env.DB_URL!,
      sync: false,
      entities: [
        AiProviderEntity,
        AiModelEntity,
        ConversationEntity,
        RunEntity,
        TimelineEntity,
      ],
    } as never,
    silentLogger,
  )
  await db.onApplicationBootstrap()
  setAuditUserProvider(() => TEST_USER)

  const providerRepo = new AiProviderRepository(db)
  const modelRepo = new AiModelRepository(db)
  const modelConfig: AiModelConfig = {
    encryptionKey: TEST_SECRET,
    fallbackSecret: undefined,
    seedFromEnv: false,
  }
  modelService = new AiModelService(providerRepo, modelRepo, modelConfig, silentLogger)

  // ① 造一家**指向 mock 服务**的供应商（openai-compatible：必须显式 baseUrl）
  const provider = await modelService.createProvider({
    name: `模型选择测试供应商 ${randomBytes(3).toString('hex')}`,
    kind: AiProviderKind.OpenaiCompatible,
    baseUrl: mock.baseURL,
    apiKey: TEST_API_KEY,
  })
  providerId = provider.id

  // ② 两个模型：一个启用（会被选中）、一个禁用（用来证明"不可用就不给用"）
  const enabled = await modelService.createModel({
    providerId,
    modelKey: SELECTED_MODEL_KEY,
    displayName: '被选中的模型',
    enabled: true,
  })
  selectedModelId = enabled.id
  const disabled = await modelService.createModel({
    providerId,
    modelKey: 'mock-chat',
    displayName: '被禁用的模型',
    enabled: false,
  })
  disabledModelId = disabled.id

  // ③ 编排层 + Mastra（模型**每次调用**从运行时信封里取，与线上装配同一口径）
  const conversationRepo = new ConversationRepository(db)
  const runs = new RunRepository(db)
  const timelines = new TimelineRepository(db)
  const config = { ...TEST_CONFIG, baseURL: mock.baseURL } as never
  const runner = new AgentRunner(runs, timelines, config, silentLogger)
  const skillLoader = new SkillLoader(silentLogger)
  const toolBuilder = new ToolBuilder([], [
    new PlannerCore(timelines),
    new SubAgentCore(runner, silentLogger),
  ])
  const registry = createAgentRegistry(
    createAgentDefinitions(createPromptEngine(), toolBuilder),
    DEFAULT_AGENT_KEY,
  )
  const mastra = await createMastra({
    resolveModel: (_definition, requestContext) => {
      // 与 `ai.module.ts` 完全同一套决策（纯函数，另有专门的单测锁它的两条硬约束）
      const model = readAgentRuntime(requestContext)?.model
      if (!model) throw new Error('测试栈：运行时信封里没有模型')
      return decideModelForMastra(model).model
    },
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
  chat = new AgentChatService(
    mastra,
    registry,
    config,
    conversations,
    conversationRepo,
    runs,
    timelines,
    new ContextService(timelines, config, silentLogger),
    {} as never,
    toolBuilder,
    skillLoader,
    modelService,
    silentLogger,
  )
})

afterAll(async () => {
  setAuditUserProvider(undefined)
  for (const id of createdConversationIds) {
    await db.dataSource.query('DELETE FROM timelines WHERE conversation_id = $1', [id])
    await db.dataSource.query('DELETE FROM runs WHERE conversation_id = $1', [id])
    await db.dataSource.query('DELETE FROM conversations WHERE id = $1', [id])
  }
  if (providerId) {
    await db.dataSource.query('DELETE FROM ai_models WHERE provider_id = $1', [providerId])
    await db.dataSource.query('DELETE FROM ai_providers WHERE id = $1', [providerId])
  }
  await db.onApplicationShutdown()
  await mock.close()
})

describe('模型选择端到端（选的模型真的被用）', () => {
  it('① 传 modelId → 这一轮的请求用的就是它（不做静默回落）', async () => {
    const before = chatRequests().length
    const result = await chat.chat(TEST_USER, {
      message: '选中的模型跑一轮',
      modelId: selectedModelId,
    })
    createdConversationIds.push(result.conversationId)
    expect(result.status).toBe(RunStatus.Succeeded)

    const sent = chatRequests().slice(before)
    expect(sent.length).toBeGreaterThan(0)
    // 每一跳（规划工具往返会多跳）都必须是选中的那个模型
    expect(sent.map((request) => request.model)).toEqual(
      sent.map(() => SELECTED_MODEL_KEY),
    )

    // 运行快照记下的是"这一轮用的是哪个模型"（复盘要看得到）
    const runs = await db.dataSource.query<{ request_snapshot: { model?: string } }[]>(
      'SELECT request_snapshot FROM runs WHERE conversation_id = $1',
      [result.conversationId],
    )
    expect(runs[0].request_snapshot.model).toContain(SELECTED_MODEL_KEY)
  }, 30_000)

  it('② 传一个不存在的 modelId → 3402 且不落到别的模型上（绝不静默回落）', async () => {
    const before = chatRequests().length
    await expect(
      chat.chat(TEST_USER, { message: '用一个不存在的模型', modelId: 'model_not_exists' }),
    ).rejects.toMatchObject({ code: 3402 })
    expect(chatRequests().length).toBe(before)
  }, 30_000)

  it('③ 传一个被禁用的 modelId → 明确报错，且一个模型请求都不发（不烧钱）', async () => {
    const before = chatRequests().length
    await expect(
      chat.chat(TEST_USER, { message: '用被禁用的模型', modelId: disabledModelId }),
    ).rejects.toMatchObject({ code: 3402 })
    // 关键：拒绝发生在**建流 / 调模型之前**，所以 mock 一次都没被打到
    expect(chatRequests().length).toBe(before)
  }, 30_000)

  it('④ 官方适配（DeepSeek kind）不传 url：思考字段才不会被通用层丢掉', () => {
    const decision = decideModelForMastra({
      id: 'model_deepseek',
      modelRef: 'env-default/deepseek-flash',
      modelKey: 'deepseek-flash',
      displayName: 'deepseek-flash',
      providerKind: AiProviderKind.Deepseek,
      // 种子供应商会把 MASTRA_BASE_URL 写进 baseUrl —— 官方适配必须无视它
      baseURL: 'https://api.deepseek.com',
      apiKey: TEST_API_KEY,
      contextWindow: null,
    })
    expect(decision.officialAdapter).toBe(true)
    expect(decision.model.url).toBeUndefined()
    expect(decision.ignoredBaseURL).toBe('https://api.deepseek.com')
  })

  it('⑤ 可选模型清单只回"供应商启用 + 模型启用"的（选择器里看到的都能用）', async () => {
    const available = await modelService.listAvailable()
    expect(available.models.map((model) => model.id)).toContain(selectedModelId)
    expect(available.models.map((model) => model.id)).not.toContain(disabledModelId)
    // mock 的 `/models` 里也真有这个名字（同步链路的锚点是 `data[].id`，两边语义一致）
    expect(MOCK_MODEL_LIST.map((item) => item.id)).toContain(SELECTED_MODEL_KEY)
  })
})
