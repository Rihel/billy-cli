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
import { createMastra } from '../src/modules/ai/mastra/ai.mastra.js'
import { createAgentRegistry } from '../src/modules/ai/agents/registry.js'
import { decideModelForMastra } from '../src/modules/ai/core/model-decision.js'
import { FileTools } from '../src/modules/ai/files/file.tools.js'
import { WebTools } from '../src/modules/ai/tools/web.tools.js'
import { RunSubAgentTool } from '../src/modules/ai/tools/subagent.tool.js'
import { PlannerStore, PlannerTools } from '../src/modules/ai/tools/planner/index.js'
import { createPromptEngine } from '../src/modules/ai/core/prompts/index.js'
import { AgentTitleService } from '../src/modules/ai/runtime/title.service.js'
import { AgentChatService } from '../src/modules/ai/runtime/chat.service.js'
import { AgentConversationService } from '../src/modules/ai/runtime/conversation.service.js'
import { ConversationRepository } from '../src/modules/ai/runtime/conversation.repository.js'
import { ContextService } from '../src/modules/ai/runtime/context.service.js'
import { AgentRunner } from '../src/modules/ai/runtime/agent-runner.js'
import { RunRepository } from '../src/modules/ai/runtime/run.repository.js'
import { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'
import { SkillLoader } from '../src/modules/ai/core/skills/index.js'
import { toMastraSkills } from '../src/modules/ai/mastra/skill.adapter.js'
import { toMastraTools } from '../src/modules/ai/mastra/tool.adapter.js'
import { ReadToolResultTool } from '../src/modules/ai/tools/read-tool-result.tool.js'
import { ToolGateway } from '../src/modules/ai/core/tools/tool.gateway.js'
import { ToolRegistry } from '../src/modules/ai/core/tools/tool.registry.js'
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
import { buildToolStackDeps, makeBashTool } from './helpers/ai-tool-stack.js'
import { stubAttachments } from './helpers/attachments.js'

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
  // 命令执行（core bean `command`）：端到端要能真跑一条命令，这里给全部字段
  commandEnabled: true,
  commandTimeoutMs: 5_000,
  commandMaxOutputBytes: 64 * 1024,
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
      entities: [AiProviderEntity, AiModelEntity, ConversationEntity, RunEntity, TimelineEntity],
    } as never,
    silentLogger,
  )
  await db.onApplicationBootstrap()
  setAuditUserProvider(() => TEST_USER)

  const providerRepo = new AiProviderRepository(db)
  const modelRepo = new AiModelRepository(db)
  const modelConfig: AiModelConfig = {
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
  // 工具引擎装配（设计 §5.9）：插件链为空（e2e 只关心行为），依赖用测试替身
  const deps = buildToolStackDeps()
  const gateway = new ToolGateway(deps.config, silentLogger, [], deps.clock)
  // registry 与 runner 互相引用：给 runner 一个**延迟求值**的在册端口，避免装配成环
  let toolRegistry: ToolRegistry
  // `AgentRunner` 通过 ModuleRef **惰性**取注册机（构造期不依赖它，否则成环死锁）：
  // 测试给一个只实现 `get` 的替身，语义与生产一致
  const moduleRefPort = { get: () => toolRegistry } as never
  const runner = new AgentRunner(runs, timelines, config, silentLogger, deps.metas, moduleRefPort)
  // 工具组实例（唯一的工具来源）：与 `ai.module.ts` 的装配口径一致
  const plannerStore = new PlannerStore(timelines)
  toolRegistry = new ToolRegistry(
    [
      makeBashTool(silentLogger),
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
    // 与 `ai.module.ts` 完全同一套决策：模型由编排层放进信封，这里直接吃信封里的 RuntimeModel
    resolveModel: (_definition, model) => decideModelForMastra(model).model,
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
    new ContextService(timelines, config, silentLogger),
    chatAttachments,
    {} as never,
    toolRegistry,
    deps.metas,
    skillLoader,
    modelService,
    silentLogger,
    createPromptEngine(),
    new AgentTitleService(timelines, createPromptEngine(), silentLogger),
  )
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
  for (const userId of [TEST_USER]) {
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
    expect(sent.map((request) => request.model)).toEqual(sent.map(() => SELECTED_MODEL_KEY))

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
