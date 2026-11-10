import 'dotenv/config'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CommandRunner, Db, IdGeneration, RedisStore, setAuditUserProvider } from '@repo/kits'
import { RunStatus, TimelineKind, TimelineRole } from '@repo/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConversationEntity } from '../src/database/entities/conversation-entity.js'
import { RunEntity } from '../src/database/entities/run-entity.js'
import { TimelineEntity } from '../src/database/entities/timeline-entity.js'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from '../src/modules/ai/agents/index.js'
import { agentMemory } from '../src/modules/ai/mastra/agent-memory.js'
import { createMastra } from '../src/modules/ai/mastra/ai.mastra.js'
import { createAgentRegistry } from '../src/modules/ai/agents/registry.js'
import { createPromptEngine } from '../src/modules/ai/core/prompts/index.js'
import { AgentTitleService } from '../src/modules/ai/runtime/title.service.js'
import { SkillLoader } from '../src/modules/ai/core/skills/index.js'
import { RunCommandTool } from '../src/modules/ai/tools/command.tool.js'
import { WebTools } from '../src/modules/ai/tools/web.tools.js'
import { RunSubAgentTool } from '../src/modules/ai/tools/subagent.tool.js'
import { PlannerStore, PlannerTools } from '../src/modules/ai/tools/planner/index.js'
import { AgentRunner } from '../src/modules/ai/runtime/agent-runner.js'
import { AgentChatService, STREAM_END_MARKER } from '../src/modules/ai/runtime/chat.service.js'
import { toMastraSkills } from '../src/modules/ai/mastra/skill.adapter.js'
import { toMastraTools } from '../src/modules/ai/mastra/tool.adapter.js'
import { ReadToolResultTool } from '../src/modules/ai/tools/read-tool-result.tool.js'
import { ToolGateway } from '../src/modules/ai/core/tools/tool.gateway.js'
import { ToolRegistry } from '../src/modules/ai/core/tools/tool.registry.js'
import { AgentConversationService } from '../src/modules/ai/runtime/conversation.service.js'
import { ConversationRepository } from '../src/modules/ai/runtime/conversation.repository.js'
import { ContextService } from '../src/modules/ai/runtime/context.service.js'
import { RunRepository } from '../src/modules/ai/runtime/run.repository.js'
import { AgentStreamStore } from '../src/modules/ai/runtime/stream-store.service.js'
import { AgentMastraStore } from '../src/modules/ai/runtime/storage/agent-mastra-store.js'
import { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'
import {
  MOCK_ASK_MARKER,
  MOCK_ASK_TOOL,
  MOCK_CHILD_TEXT,
  MOCK_COMMAND_MARKER,
  MOCK_DELEGATE_MARKER,
  MOCK_DELEGATE_PARALLEL_MARKER,
  MOCK_FINAL_TEXT,
  MOCK_PLAN_CREATE_TOOL,
  MOCK_PLAN_INITIAL,
  MOCK_SLOW_MARKER,
  MOCK_TITLE_TEXT,
  type MockModelServer,
  startMockModelServer,
} from './helpers/mock-model-server.js'
import { buildToolStackDeps } from './helpers/ai-tool-stack.js'
import { STUB_IMAGE_BYTES, stubAttachments } from './helpers/attachments.js'

/**
 * 流式链路端到端：假模型 + 真实数据库 + **真实 Redis**，不需要外部密钥。
 *
 * 覆盖设计文档里几条硬要求：
 * - UI Message Stream 协议（响应头 / `data:` 帧 / `[DONE]`）；
 * - **每个 part 完成即落库**（刷新不丢内容）；
 * - 输出记录与运行中进度落在 Redis（跑完清进度）；
 * - 停止 = `canceled`（不是 failed）；
 * - 断线重连按 `offset` 补发（不重跑），没有进行中的流时返回"无流"语义。
 */

const USER = 'user_ai_stream'
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/15'

const silentLogger = {
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

let db: Db
let redis: RedisStore
let streamStore: AgentStreamStore
let mock: MockModelServer
let chat: AgentChatService
let mastra: Awaited<ReturnType<typeof createMastra>>
let conversations: AgentConversationService
let runs: RunRepository
let timelines: TimelineRepository
let http: Server
let httpBase: string
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
  subAgentMaxPerRun: 4,
  subAgentMaxDepth: 1,
  subAgentMaxSteps: 5,
  subAgentTimeoutMs: 60_000,
  // 命令执行（core bean `command`）：端到端要能真跑一条命令，这里给全部字段
  commandEnabled: true,
  commandTimeoutMs: 5_000,
  commandMaxOutputBytes: 64 * 1024,
} as never

const createdConversationIds: string[] = []
/** HTTP 处理器里逃逸出来的错误（诊断用） */
const serverErrors: unknown[] = []
/** 让下一轮"解析模型"失败（模拟 3406 / 库配置被删这类建流前错误） */
let failModelResolution = false

/** 轮询等待条件成立（收尾发生在响应结束之后的一瞬间，测试要等它） */
const waitFor = async (check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('等待超时：条件未在预期时间内成立')
}

/** 发一次流式请求，收集 SSE 原文 */
const postStream = async (body: Record<string, unknown>): Promise<{ status: number; headers: Headers; text: string }> => {
  const response = await fetch(`${httpBase}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, headers: response.headers, text }
}

/** 从 `data-run` 块取应用会话 id（不拿"最近一条会话"，避免并行测试互相抢） */
const conversationIdOfSse = (sse: string): string | undefined => {
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: {')) continue
    try {
      const chunk = JSON.parse(line.slice(6)) as {
        type?: string
        data?: { conversationId?: string }
      }
      if (chunk.type === 'data-run') return chunk.data?.conversationId
    } catch {
      // 忽略非 JSON 的注释帧
    }
  }
  return undefined
}

/** 从 UI Message Stream 的 SSE 原文里拼出正文（delta 是逐字的，不能直接对原文 toContain） */
const uiTextOfSse = (sse: string): string =>
  sse
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => {
      try {
        return JSON.parse(line.slice(6)) as { type?: string; delta?: string }
      } catch {
        return null
      }
    })
    .filter((chunk): chunk is { type: string; delta: string } => chunk?.type === 'text-delta')
    .map((chunk) => chunk.delta)
    .join('')

/** 回答挂起的一轮（同样是 SSE，收完再断言） */
const postResume = async (body: Record<string, unknown>): Promise<{ status: number; text: string }> => {
  const response = await fetch(`${httpBase}/chat/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
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

  // 模型解析替身：这些测试不走"从库里取模型"那条链路（那是 ai-model 模块测试的事），
  // 但编排层现在必须拿到一个解析结果 —— 给它一个恒定的 mock 模型即可
  const modelsStub = {
    resolveForRuntime: async () => {
      if (failModelResolution) throw new Error('模拟：库里没有可用模型')
      return {
        id: 'model_mock',
        modelRef: 'mock/mock-model',
        modelKey: 'mock-model',
        displayName: 'Mock 模型',
        baseURL: mock.baseURL,
        apiKey: 'test-key',
        contextWindow: null,
      }
    },
  } as never


  redis = new RedisStore({ url: REDIS_URL, keyPrefix: 'aitest:' } as never, new IdGeneration(), silentLogger)
  await redis.onApplicationBootstrap()
  streamStore = new AgentStreamStore(redis, silentLogger)

  const conversationRepo = new ConversationRepository(db)
  runs = new RunRepository(db)
  timelines = new TimelineRepository(db)

  // 子 agent 执行器（core bean `subagent` 依赖它）：配置必须给全子 agent 字段 + mock 的 baseURL
  const config = { ...TEST_CONFIG, baseURL: mock.baseURL } as never
  // 工具引擎装配（设计 §5.9）：插件链为空（e2e 只关心行为），依赖用测试替身
  const deps = buildToolStackDeps()
  const gateway = new ToolGateway(deps.config, silentLogger, [], deps.clock)
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
  // 工具组实例（唯一的工具来源）：与 `ai.module.ts` 的装配口径一致
  const plannerStore = new PlannerStore(timelines)
  toolRegistry = new ToolRegistry(
    [
      new RunCommandTool(new CommandRunner(), silentLogger),
      new RunSubAgentTool(runner, silentLogger),
      new PlannerTools(plannerStore),
      new ReadToolResultTool(deps.results, deps.counter, deps.caps),
      new WebTools(silentLogger as never),
    ],
    gateway,
    deps.config,
  )
  const registry = createAgentRegistry(
    createAgentDefinitions(createPromptEngine(), toolRegistry),
    DEFAULT_AGENT_KEY,
  )
  const skillLoader = new SkillLoader(silentLogger)
  mastra = await createMastra({
    // 模型改为"按 envelope 里的模型"求值的动态参数；这些测试不验证选模型，给恒定 mock 模型
    resolveModel: () => ({ id: 'mock/mock-model', url: mock.baseURL, apiKey: 'test-key' }),
    definitions: registry.all(),
    resolveTools: (keys) => toMastraTools(toolRegistry.toolbox(keys), silentLogger),
    resolveSkills: async (names) => toMastraSkills(await skillLoader.resolve(names)),
    durableAgents: true,
    storage: new AgentMastraStore(db, silentLogger),
  })

  conversations = new AgentConversationService(conversationRepo, runs, timelines, registry, silentLogger)
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
    createPromptEngine(),
    new AgentTitleService(timelines, createPromptEngine(), silentLogger),
  )

  // 真 HTTP 服务：让 `pipeUIMessageStreamToResponse` 走真实的 ServerResponse
  http = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      const run =
        req.url === '/chat/resume'
          ? chat.resumeChat(USER, body as never, res)
          : chat.chatStream(USER, body as never, res)
      void run.catch((error: unknown) => {
        serverErrors.push(error)
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

describe('流式链路端到端（mock 模型 + 真实 DB + 真实 Redis）', () => {
  it('SSE 协议正确：响应头 / data 帧 / [DONE]，且内容逐段落库、收尾完整', async () => {
    const { status, headers, text } = await postStream({ message: '帮我看看待办' })
    expect(status).toBe(200)
    expect(headers.get('content-type')).toContain('text/event-stream')
    expect(headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    expect(text).toContain('data: ')
    expect(text).toContain('[DONE]')

    // 会话与运行（从库里反查）
    const conversation = await conversations.list(USER, { page: 1, size: 1, includeDeleted: false })
    const conversationId = conversation.items[0].id
    createdConversationIds.push(conversationId)

    const run = await runs.findActive(conversationId)
    // 跑完就不该再有"进行中"的运行
    expect(run).toBeNull()

    const page = await timelines.list({ conversationId, page: 1, size: 200 })
    const kinds = page.items.map((item) => item.kind)
    expect(kinds).toContain(TimelineKind.Text)
    expect(kinds).toContain(TimelineKind.ToolCall)
    expect(kinds).toContain(TimelineKind.ToolResult)
    expect(kinds).toContain(TimelineKind.Step)
    // 流式链路同样把 `plan-create` 的出参落成 `plan` 事件（与工具结果同一套保真口径）
    expect(kinds).toContain(TimelineKind.Plan)
    const planRow = page.items.find((item) => item.kind === TimelineKind.Plan)
    expect(planRow?.payload).toMatchObject({ revision: 1, goal: MOCK_PLAN_INITIAL.goal })
    // 工具结果行也要认得出是哪个工具：AI SDK 的结果片段不带工具名（只有 toolCallId），
    // 录制器必须用入参那一步记下的名字补上（否则审计与 `plan` 识别都会失效）
    expect(page.items.find((item) => item.kind === TimelineKind.ToolResult)?.toolKey).toBe(
      MOCK_PLAN_CREATE_TOOL,
    )

    // 助手文本与工具结果都完整落库
    const assistantText = page.items
      .filter((item) => item.kind === TimelineKind.Text && item.role === 'assistant')
      .map((item) => String(item.payload?.text ?? ''))
      .join('')
    expect(assistantText).toContain(MOCK_FINAL_TEXT)

    const runRow = await db.dataSource.query<
      {
        id: string
        status: string
        usage: unknown
        engine_run_id: string | null
        snapshot: unknown
        first_token_ms: number | null
        duration_ms: number | null
        request_snapshot: Record<string, unknown> | null
      }[]
    >(
      `SELECT id, status, usage, engine_run_id, snapshot, first_token_ms, duration_ms, request_snapshot
       FROM runs WHERE conversation_id = $1`,
      [conversationId],
    )
    expect(runRow[0]?.status).toBe(RunStatus.Succeeded)
    /**
     * **引擎 runId 必须回写、快照必须落库**（2026-10-07 修的洞）。
     *
     * 曾经这两个字段一直是空的：`runs.engine_run_id` 没人写，而快照落库是
     * `UPDATE runs SET snapshot ... WHERE engine_run_id = :runId` —— 找不到宿主就**丢掉快照**，
     * 于是"崩溃后从快照续跑"这条线**从未真正生效**（库里 60 条运行只有 13 条早期手工造的带快照）。
     * 现在引擎 runId 由我们生成（`eng_<runId>`）并同时交给 Mastra，两边对得上。
     */
    expect(runRow[0]?.engine_run_id).toBe(`eng_${runRow[0]?.id}`)
    // 快照是否真的落库由 `ai-storage-recovery.test.ts` 专门验（那里的装配开了 durable；这个 e2e 没开）
    expect(runRow[0]?.usage).toBeTruthy()
    // 缓存命中**必须落到库里**（Mastra 放在顶层 `cachedInputTokens`，早先只读嵌套字段 → 永远是 null，
    // 用户看到"缓存命中没数"；mock 的 `prompt_tokens_details.cached_tokens = 64` 就是为这条链路加的）。
    // 数值口径：本轮是**两步**流程（先 plan-create 再回答）= 两次模型调用，mock 每次命中 64，
    // Mastra 把两次**累加**成 128；再加上**首轮自动命名**那次隔离调用（同样是 64）→ 192。
    // 命名调用**并进这一轮的 usage**（`runs.usage` 的语义就是"这一轮花掉的钱"，见设计文档 §4.10.1）。
    // 精确的字段优先级（顶层 64 胜过嵌套）由 `ai-usage.test.ts` 的纯函数单测钉住。
    expect(runRow[0]?.usage).toMatchObject({ cacheReadTokens: 192 })

    /**
     * **观测三件套（2026-10-29 加）**：首 token 耗时 / 输入快照 / 进度+耗时列。
     *
     * 曾经 `runs.first_token_ms` 全库为空（代码里没有任何写入点）、快照只在成功收尾时写、
     * 步与工具的耗时只躺在 `payload.outcome` 里 —— 于是"慢在哪一层"永远查不出来。
     */
    expect(typeof runRow[0]?.first_token_ms).toBe('number')
    expect(runRow[0]?.first_token_ms as number).toBeGreaterThanOrEqual(0)
    expect(typeof runRow[0]?.duration_ms).toBe('number')
    // 快照里要有模型与上下文取舍（失败轮也会写，这里先钉成功路径）
    expect(runRow[0]?.request_snapshot).toMatchObject({
      agentKey: DEFAULT_AGENT_KEY,
      params: { maxSteps: expect.any(Number) },
    })
    expect(runRow[0]?.request_snapshot?.context).toBeTruthy()

    // 步耗时与工具耗时落到列上（不是只留在 payload.outcome）
    const stepRow = page.items.find((item) => item.kind === TimelineKind.Step)
    expect(typeof stepRow?.durationMs).toBe('number')
    expect(stepRow?.durationMs as number).toBeGreaterThanOrEqual(0)
    // 工具耗时要靠网关的审计旁证（这个 e2e 刻意不装插件，见装配处的 `new ToolGateway(..., [])`），
    // 因此"耗时落列 + 拒绝分桶"由 `ai-stream-recorder-observability.test.ts` 用 meta 替身钉住
    expect(
      page.items
        .filter((item) => item.kind === TimelineKind.ToolResult)
        .map((item) => item.state),
    ).toContain('output-available')
  })

  it('首轮自动命名：收尾时用 `data-conversation-title` 实时下发（前端不必等下一次刷新）', async () => {
    const { status, text } = await postStream({ message: '帮我看看最近有哪些待办' })
    expect(status).toBe(200)

    // 与 `data-run-usage` 同一手法：先给客户端，再进 Redis 输出记录（于是断线补发也拿得到）
    expect(text).toContain('data-conversation-title')
    expect(text).toContain(MOCK_TITLE_TEXT)

    const conversationId = /"conversationId":"([^"]+)"/.exec(text)?.[1]
    expect(conversationId).toBeTruthy()
    if (conversationId) createdConversationIds.push(conversationId)

    // 推送与落库**同一口径**：库里也确实是这个名字
    const rows = await db.dataSource.query<{ title: string }[]>(
      'SELECT title FROM conversations WHERE id = $1',
      [conversationId],
    )
    expect(rows[0]?.title).toBe(MOCK_TITLE_TEXT)
  })

  it('子 agent 的实时明细走**同一条流**（data-sub-agent 状态块 + data-sub-agent-delta 增量块）', async () => {
    const before = mock.requests.length
    const { status, text } = await postStream({ message: `流式统计 ${MOCK_DELEGATE_MARKER}` })
    expect(status).toBe(200)

    // ① 状态块：带 id（= 子 run id），前端按 id 归并出"这个子助手当前什么样"
    const stateFrames = text
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: ') && frame.includes('"data-sub-agent"'))
      .map((frame) => JSON.parse(frame.slice(6)) as { id?: string; data?: Record<string, unknown> })
    expect(stateFrames.length).toBeGreaterThan(0)
    const childRunId = stateFrames[0].id
    expect(childRunId).toBeTruthy()
    expect(stateFrames.some((frame) => frame.data?.status === 'running')).toBe(true)
    expect(stateFrames.some((frame) => frame.data?.status === 'succeeded')).toBe(true)
    // 收尾的那一块带上结论与消耗（前端不必再查库就能显示）
    const finished = stateFrames.find((frame) => frame.data?.status === 'succeeded')
    expect(String(finished?.data?.result)).toContain(MOCK_CHILD_TEXT)
    expect(finished?.data?.usage).toBeTruthy()

    // ② 增量块：**不带 id**（AI SDK 的 data part 按 id 归并，同 id 会互相覆盖 —— 增量必须一块一个）
    const deltaFrames = text
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: ') && frame.includes('"data-sub-agent-delta"'))
      .map((frame) => JSON.parse(frame.slice(6)) as { id?: string; data?: Record<string, unknown> })
    expect(deltaFrames.length).toBeGreaterThan(0)
    expect(deltaFrames.every((frame) => frame.id === undefined)).toBe(true)
    const streamed = deltaFrames.map((frame) => frame.data?.text ?? '').join('')
    // 子助手的结论文本**逐段**流过来了（不是最后一次性出现）
    expect(streamed).toContain(MOCK_CHILD_TEXT)
    expect(deltaFrames.some((frame) => frame.data?.kind === 'reasoning')).toBe(false)

    // ③ 子 agent 那一轮确实被调用了（系统提示词里带 [child] 标记）
    const childRequest = mock.requests
      .slice(before)
      .find((body) => JSON.stringify(body.messages ?? []).includes('[child]'))
    expect(childRequest).toBeDefined()
  }, 30_000)

  it('跑完后：进度键被清掉（输出记录仍在，供刚断线的客户端补发）', async () => {
    const conversation = await conversations.create(USER, {})
    createdConversationIds.push(conversation.id)
    await postStream({ conversationId: conversation.id, message: '再问一次' })

    if (serverErrors.length > 0) throw new Error(`流式处理器抛错：${String(serverErrors[0])}`)
    const finishedRun = await db.dataSource.query<{ id: string }[]>(
      'SELECT id FROM runs WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1',
      [conversation.id],
    )
    const runId = finishedRun[0].id
    await waitFor(async () => (await streamStore.readRun(runId)) === null)
    expect(await streamStore.readRun(runId)).toBeNull()
    expect((await streamStore.readChunks(runId, 0)).length).toBeGreaterThan(0)
  })

  it('停止：运行中的一轮被中断 → 状态是 canceled（不是 failed）', async () => {
    const conversation = await conversations.create(USER, {})
    createdConversationIds.push(conversation.id)

    // 慢速流：留出可打断的窗口
    const pending = postStream({ conversationId: conversation.id, message: `慢一点 ${MOCK_SLOW_MARKER}` })
    await new Promise((resolve) => setTimeout(resolve, 200))

    const active = await runs.findActive(conversation.id)
    expect(active).not.toBeNull()

    const result = await chat.stopRun(USER, active!.id)
    expect(result.stopped).toBe(true)
    const slowResponse = await pending
    if (serverErrors.length > 0) {
      throw new Error(`流式处理器抛错：${String(serverErrors[0])}`)
    }
    expect(slowResponse.status).toBe(200)

    const readStatus = async (): Promise<string | undefined> => {
      const rows = await db.dataSource.query<{ status: string }[]>(
        'SELECT status FROM runs WHERE id = $1',
        [active!.id],
      )
      return rows[0]?.status
    }
    await waitFor(async () => (await readStatus()) !== RunStatus.Running)
    expect(await readStatus()).toBe(RunStatus.Canceled)

    // 时间线留下"谁停的、为什么"（审计证据）
    const statusRows = await db.dataSource.query<{ payload: Record<string, unknown> }[]>(
      "SELECT payload FROM timelines WHERE run_id = $1 AND kind = 'status'",
      [active!.id],
    )
    expect(statusRows.some((item) => item.payload?.reason === 'user_stopped')).toBe(true)
  })

  it('重连补发：按 offset 从输出记录补发，遇到结束标记就收尾（不重跑）', async () => {
    // 手工种一次"正在跑"的运行 + 两条输出记录 + 结束标记，确定性地验证补发逻辑
    const conversation = await conversations.create(USER, {})
    createdConversationIds.push(conversation.id)
    const run = await runs.create({
      conversationId: conversation.id,
      agentKey: DEFAULT_AGENT_KEY,
      status: RunStatus.Running,
    })
    await streamStore.startRun(run.id, { status: RunStatus.Running, stage: 'generating' })
    await streamStore.appendChunk(run.id, { type: 'text-delta', id: 't1', delta: '补发1' })
    await streamStore.appendChunk(run.id, { type: 'text-delta', id: 't1', delta: '补发2' })
    await streamStore.appendChunk(run.id, { type: STREAM_END_MARKER })

    const frames: string[] = []
    const resumed = await chat.resumeRun(USER, run.id, 0, {
      writeHead: () => undefined,
      flushHeaders: () => undefined,
      write: (chunk: string) => frames.push(chunk),
      end: () => undefined,
      writableEnded: false,
      on: () => undefined,
    })
    expect(resumed).toBe(true)
    expect(frames.join('')).toContain('补发1')
    expect(frames.join('')).toContain('补发2')

    await runs.finish(run.id, { status: RunStatus.Interrupted })
    await streamStore.clearRun(run.id)
  })

  it('按用户续流（不知道 runId 时）：找到进行中的那一轮就补发，没有就返回 false → 204', async () => {
    // 场景：页面刷新后前端不知道 runId（它只在 data-run 块里给过一次）→ 服务端按登录用户找
    const conversation = await conversations.create(USER, {})
    createdConversationIds.push(conversation.id)

    // ① 没有进行中的运行 → false（控制器回 204，AI SDK 静默收尾）
    const emptyFrames: string[] = []
    const none = await chat.resumeCurrentRun(USER, 0, {
      writeHead: () => undefined,
      write: (chunk: string) => emptyFrames.push(chunk),
      end: () => undefined,
      writableEnded: false,
      on: () => undefined,
    })
    expect(none).toBe(false)
    expect(emptyFrames).toHaveLength(0)

    // ② 有进行中的运行 → 补发（含本轮身份 data-run，前端据此重新拿到 runId）
    const run = await runs.create({
      conversationId: conversation.id,
      agentKey: DEFAULT_AGENT_KEY,
      status: RunStatus.Running,
      triggeredBy: USER,
    })
    await streamStore.startRun(run.id, { status: RunStatus.Running, stage: 'generating' })
    await streamStore.appendChunk(run.id, {
      type: 'data-run',
      data: { runId: run.id, conversationId: conversation.id, agentKey: DEFAULT_AGENT_KEY },
    })
    await streamStore.appendChunk(run.id, { type: 'text-delta', id: 't1', delta: '接回来了' })
    await streamStore.appendChunk(run.id, { type: STREAM_END_MARKER })

    const frames: string[] = []
    const resumed = await chat.resumeCurrentRun(USER, 0, {
      writeHead: () => undefined,
      flushHeaders: () => undefined,
      write: (chunk: string) => frames.push(chunk),
      end: () => undefined,
      writableEnded: false,
      on: () => undefined,
    })
    expect(resumed).toBe(true)
    expect(frames.join('')).toContain('接回来了')
    expect(frames.join('')).toContain(run.id)

    await runs.finish(run.id, { status: RunStatus.Interrupted })
    await streamStore.clearRun(run.id)
  }, 30_000)

  /**
   * 崩溃重启后旧进程没来得及删 Redis 进度（TTL 6h），而 Postgres 里这一轮已经被
   * 启动清理标成 `interrupted`。重连必须以 **Postgres 终态**为准返回 false，
   * 否则客户端会"接回"一条永远没有新片段的死流。
   */
  it('已中断的运行：即使 Redis 进度还在，也不接回（Postgres 终态优先）', async () => {
    const conversation = await conversations.create(USER, {})
    createdConversationIds.push(conversation.id)
    const run = await runs.create({
      conversationId: conversation.id,
      agentKey: DEFAULT_AGENT_KEY,
      status: RunStatus.Interrupted,
    })
    // 模拟旧进程留下的进度键
    await streamStore.startRun(run.id, { status: RunStatus.Running, stage: 'generating' })

    const resumed = await chat.resumeRun(USER, run.id, 0, {
      writeHead: () => undefined,
      write: () => undefined,
      end: () => undefined,
      writableEnded: false,
      on: () => undefined,
    })
    expect(resumed).toBe(false)
    await streamStore.clearRun(run.id)
  })

  it('没有进行中的流 → 重连返回 false（控制器据此回 204）', async () => {
    const conversation = await conversations.create(USER, {})
    createdConversationIds.push(conversation.id)
    const run = await runs.create({
      conversationId: conversation.id,
      agentKey: DEFAULT_AGENT_KEY,
      status: RunStatus.Succeeded,
    })
    const resumed = await chat.resumeRun(USER, run.id, 0, {
      writeHead: () => undefined,
      write: () => undefined,
      end: () => undefined,
      writableEnded: false,
      on: () => undefined,
    })
    expect(resumed).toBe(false)
  })

  /**
   * 带附件的**流式**用例（2026-10-07 补）。
   *
   * 为什么必须单独有这一条：用户实际走的就是流式，而"带附件"的用例原先只覆盖了非流式 ——
   * 曾经有个 bug（Mastra 在 durable 下把多模态 content 压平成字符串、图片静默丢失）
   * 恰好只在"官方适配器 + 某条调用路径"上现形，非流式用例与 mock 路径都看不见它。
   * 这里断言的是**模型真的收到了图**，而不只是"接口返回 200"。
   */
  it('带附件：图片真的进了模型请求（流式路径同样不被压平）', async () => {
    const attachment = {
      key: 'user_ai_stream/shot.png',
      filename: 'shot.png',
      mediaType: 'image/png',
      bytes: STUB_IMAGE_BYTES.length,
    }
    const expectedDataUrl = `data:image/png;base64,${STUB_IMAGE_BYTES.toString('base64')}`

    mock.requests.length = 0
    const { status, text } = await postStream({ message: '这张图里有什么？', attachments: [attachment] })
    expect(status).toBe(200)
    expect(text).toContain('[DONE]')

    // 1) 模型请求里有这张图（data URL 形式的 image part）
    const withImage = mock.requests.filter((body) => JSON.stringify(body).includes(expectedDataUrl))
    expect(withImage.length).toBeGreaterThanOrEqual(1)

    // 2) 库里只落元数据：**不含 base64**（审计表不被内容撑变形）
    const conversation = await conversations.list(USER, { page: 1, size: 1, includeDeleted: false })
    const conversationId = conversation.items[0].id
    createdConversationIds.push(conversationId)
    const rows = await db.dataSource.query<{ payload: Record<string, unknown> }[]>(
      'SELECT payload FROM timelines WHERE conversation_id = $1 AND role = $2',
      [conversationId, TimelineRole.User],
    )
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const dumped = JSON.stringify(rows.map((row) => row.payload))
    expect(dumped).not.toContain('base64')
    expect(dumped).toContain('shot.png')
  })

  it('工具挂起：问题卡事件落库，回答后用同一个 run 续跑', async () => {
    const { status, text } = await postStream({ message: `先问我几个问题 ${MOCK_ASK_MARKER}` })
    expect(status).toBe(200)
    expect(text).toContain('data-tool-call-suspended')
    expect(text).toContain('这份给谁看')

    const conversationId = conversationIdOfSse(text)!
    expect(conversationId).toBeTruthy()
    createdConversationIds.push(conversationId)

    // 挂起不是成功：会话仍被这一轮占着，状态是 suspended
    const suspended = await runs.findActive(conversationId)
    expect(suspended?.status).toBe(RunStatus.Suspended)
    expect(suspended?.id).toBeTruthy()
    const before = await timelines.list({ conversationId, page: 1, size: 200 })
    expect(before.items.some((item) => item.kind === TimelineKind.ToolSuspended)).toBe(true)
    const snap = await db.dataSource.query<{ snapshot: unknown; engine_run_id: string }[]>(
      'SELECT snapshot, engine_run_id FROM runs WHERE id = $1',
      [suspended!.id],
    )
    // 外层 loop 与内层 execution 两个快照都要在；只留一个会让 resume 丢 typedInput
    expect(Object.keys(snap[0]?.snapshot as object).sort()).toEqual([
      'durable-agentic-execution',
      'durable-agentic-loop',
    ])
    const suspendedRuns = (await mastra.getAgent('assistant').listSuspendedRuns()) as {
      total: number
    }
    expect(suspendedRuns.total).toBeGreaterThan(0)
    const memory = await agentMemory.recall({
      threadId: conversationId,
      resourceId: USER,
    })
    expect(memory.total).toBeGreaterThan(0)

    // 挂起期间同一会话不能再开一轮（部分唯一索引把 suspended 算作进行中）。
    // 这个测试 HTTP 壳没有全局 AppErrorFilter，所以只断言"被挡住"，不锁 409。
    const busy = await postStream({ conversationId, message: '挂起期间再开一轮' })
    expect(busy.status).not.toBe(200)
    serverErrors.length = 0

    const resumed = await postResume({
      runId: suspended!.id,
      toolCallId: 'call_mock_ask',
      answers: [
        { id: 'audience', value: '长辈自己' },
        { id: 'topics', value: ['接电话'] },
      ],
    })
    expect(resumed.status).toBe(200)
    expect(uiTextOfSse(resumed.text)).toContain(MOCK_FINAL_TEXT)
    expect(resumed.text).toContain('[DONE]')
    expect(resumed.text).toContain('[DONE]')

    // 同一条 run 走完：不再占会话，状态 succeeded
    expect(await runs.findActive(conversationId)).toBeNull()
    const rows = await db.dataSource.query<{ status: string }[]>(
      'SELECT status FROM runs WHERE id = $1',
      [suspended!.id],
    )
    expect(rows[0]?.status).toBe(RunStatus.Succeeded)

    // 工具结果行也要认得出是哪个工具（历史重建靠它把问题卡收起来）
    const after = await timelines.list({ conversationId, page: 1, size: 200 })

    expect(
      after.items.some(
        (item) => item.kind === TimelineKind.ToolResult && item.toolKey === MOCK_ASK_TOOL,
      ),
    ).toBe(true)

    // 问答记录要能**结构化**重建：时间线存的是 `{ answers }`（不是拼给模型看的文本），
    // 历史重建据此按题还原"问了什么 / 答了什么"，卡片留在原位置
    const answerRow = after.items.find(
      (item) => item.kind === TimelineKind.ToolResult && item.toolKey === MOCK_ASK_TOOL,
    )
    const answerOutput = (answerRow?.payload as
      | { output?: { text?: unknown; answers?: unknown } }
      | undefined)?.output
    // 出参是结构化对象：`text` 给模型读、`answers` 给前端还原；模型那份由 toModelOutput 只取 text
    expect(answerOutput?.text).toContain('用户已回答')
    expect(answerOutput?.answers).toEqual([
      { id: 'audience', value: '长辈自己' },
      { id: 'topics', value: ['接电话'] },
    ])
  }, 30_000)

  it('工具挂起：取消整组回答也会续跑，并把 cancelled 落进时间线', async () => {
    const { status, text } = await postStream({ message: `先问再取消 ${MOCK_ASK_MARKER}` })
    expect(status).toBe(200)
    const conversationId = conversationIdOfSse(text)!
    expect(conversationId).toBeTruthy()
    createdConversationIds.push(conversationId)

    const suspended = await runs.findActive(conversationId)
    expect(suspended?.status).toBe(RunStatus.Suspended)
    expect(suspended?.id).toBeTruthy()

    // 取消不是 stop：带上 `{ cancelled: true }` 从同一条 run 续跑，模型继续干活
    const resumed = await postResume({
      runId: suspended!.id,
      toolCallId: 'call_mock_ask',
      cancelled: true,
    })
    expect(resumed.status).toBe(200)
    expect(uiTextOfSse(resumed.text)).toContain(MOCK_FINAL_TEXT)
    expect(resumed.text).toContain('[DONE]')

    expect(await runs.findActive(conversationId)).toBeNull()
    const rows = await db.dataSource.query<{ status: string }[]>(
      'SELECT status FROM runs WHERE id = $1',
      [suspended!.id],
    )
    expect(rows[0]?.status).toBe(RunStatus.Succeeded)

    const after = await timelines.list({ conversationId, page: 1, size: 200 })
    const cancelRow = after.items.find(
      (item) => item.kind === TimelineKind.ToolResult && item.toolKey === MOCK_ASK_TOOL,
    )
    const cancelOutput = (cancelRow?.payload as
      | { output?: { cancelled?: unknown; answers?: unknown } }
      | undefined)?.output
    expect(cancelOutput?.cancelled).toBe(true)
    expect(cancelOutput?.answers).toEqual([])
  }, 30_000)

  it('子 agent 并行：一步派 4 个，最多同时跑 3 个（第 4 个排队）', async () => {
    const { status, text } = await postStream({
      message: `并行跑四路子助手 ${MOCK_DELEGATE_PARALLEL_MARKER}`,
    })
    expect(status).toBe(200)
    const conversationId = conversationIdOfSse(text)!
    expect(conversationId).toBeTruthy()
    createdConversationIds.push(conversationId)

    const children = await db.dataSource.query<
      { id: string; status: string; started_at: string; finished_at: string }[]
    >(
      `SELECT id, status, started_at, finished_at FROM runs
        WHERE conversation_id = $1 AND parent_run_id IS NOT NULL
        ORDER BY started_at`,
      [conversationId],
    )
    expect(children).toHaveLength(4)
    expect(children.every((row) => row.status === RunStatus.Succeeded)).toBe(true)

    // 并发峰值 = 运行区间的最大重叠数：闸门是 3，第 4 个必须等前面有一个跑完
    const points = children
      .flatMap((row) => [
        { at: new Date(row.started_at).getTime(), delta: 1 },
        { at: new Date(row.finished_at).getTime(), delta: -1 },
      ])
      .sort((left, right) => left.at - right.at || left.delta - right.delta)
    let active = 0
    let peak = 0
    for (const point of points) {
      active += point.delta
      peak = Math.max(peak, active)
    }
    expect(peak).toBe(3)
  }, 60_000)

  it('挂起中的一轮可以主动停止，释放会话', async () => {
    const { status, text } = await postStream({ message: `问完就停 ${MOCK_ASK_MARKER}` })
    expect(status).toBe(200)
    expect(text).toContain('data-tool-call-suspended')

    const conversationId = conversationIdOfSse(text)!
    expect(conversationId).toBeTruthy()
    createdConversationIds.push(conversationId)
    const suspended = await runs.findActive(conversationId)
    expect(suspended?.status).toBe(RunStatus.Suspended)

    await chat.stopRun(USER, suspended!.id)
    expect(await runs.findActive(conversationId)).toBeNull()
    const rows = await db.dataSource.query<{ status: string }[]>(
      'SELECT status FROM runs WHERE id = $1',
      [suspended!.id],
    )
    expect(rows[0]?.status).toBe(RunStatus.Canceled)
  }, 30_000)

  /**
   * **建流前失败也必须落终态**（2026-10-18 修）。
   *
   * 早先"解析模型 / 读附件 / 组装上下文"写在 try 外面：一失败只留下一条 `running` 的行，
   * 前端看不到错误，下一次发送还会被部分唯一索引挡成 3306，直到看门狗 60s 后判超时。
   * 这里用"模型解析失败"复现，断言：
   * 1. 请求本身报错（不是空回答）；
   * 2. 会话**立刻**可以再发一轮（没有遗留的进行中运行）。
   */
  it('建流前失败：运行落终态，会话不会被锁死（可直接重试）', async () => {
    const conversation = await conversations.create(USER, {})
    createdConversationIds.push(conversation.id)

    failModelResolution = true
    try {
      const failed = await postStream({ conversationId: conversation.id, message: '这一轮应该失败' })
      expect(failed.status).not.toBe(200)
    } finally {
      failModelResolution = false
    }

    // 没有遗留的进行中运行 —— 下一个 3306 就不会出现
    expect(await runs.findActive(conversation.id)).toBeNull()

    // 紧接着重试：同一个会话应当能直接开跑（不被 3306 挡）
    const retried = await postStream({ conversationId: conversation.id, message: '再试一次' })
    expect(retried.status).toBe(200)
    expect(retried.text).toContain('[DONE]')

    // 这个用例故意让处理器抛了一次错，清掉以免影响后面的断言（本文件把它们当"意外"）
    serverErrors.length = 0
  })
})
