import 'dotenv/config'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CommandRunner, Db, IdGeneration, RedisStore, setAuditUserProvider } from '@repo/kits'
import { RunStatus, TimelineKind } from '@repo/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConversationEntity } from '../src/database/entities/conversation-entity.js'
import { RunEntity } from '../src/database/entities/run-entity.js'
import { TimelineEntity } from '../src/database/entities/timeline-entity.js'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from '../src/modules/ai/agents/index.js'
import { createMastra } from '../src/modules/ai/core/ai.mastra.js'
import { createAgentRegistry } from '../src/modules/ai/core/ai.registry.js'
import { createPromptEngine } from '../src/modules/ai/prompts/index.js'
import { AgentTitleService } from '../src/modules/ai/runtime/title.service.js'
import { SkillLoader } from '../src/modules/ai/skills/index.js'
import { ToolBuilder } from '../src/modules/ai/tools/tool.builder.js'
import { PlannerCore } from '../src/modules/ai/core/planner.core.js'
import { SubAgentCore } from '../src/modules/ai/core/subagent.core.js'
import { CommandCore } from '../src/modules/ai/core/command.core.js'
import { AgentRunner } from '../src/modules/ai/runtime/agent-runner.js'
import { AgentChatService, STREAM_END_MARKER } from '../src/modules/ai/runtime/chat.service.js'
import { AgentConversationService } from '../src/modules/ai/runtime/conversation.service.js'
import { ConversationRepository } from '../src/modules/ai/runtime/conversation.repository.js'
import { ContextService } from '../src/modules/ai/runtime/context.service.js'
import { RunRepository } from '../src/modules/ai/runtime/run.repository.js'
import { AgentStreamStore } from '../src/modules/ai/runtime/stream-store.service.js'
import { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'
import {
  MOCK_CHILD_TEXT,
  MOCK_DELEGATE_MARKER,
  MOCK_FINAL_TEXT,
  MOCK_SLOW_MARKER,
  MOCK_TODO_INITIAL,
  MOCK_TODO_TOOL,
  type MockModelServer,
  startMockModelServer,
} from './helpers/mock-model-server.js'

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
  subAgentMaxPerRun: 3,
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


  redis = new RedisStore({ url: REDIS_URL, keyPrefix: 'aitest:' } as never, new IdGeneration(), silentLogger)
  await redis.onApplicationBootstrap()
  streamStore = new AgentStreamStore(redis, silentLogger)

  const conversationRepo = new ConversationRepository(db)
  runs = new RunRepository(db)
  timelines = new TimelineRepository(db)

  // 子 agent 执行器（core bean `subagent` 依赖它）：配置必须给全子 agent 字段 + mock 的 baseURL
  const config = { ...TEST_CONFIG, baseURL: mock.baseURL } as never
  const runner = new AgentRunner(runs, timelines, config, silentLogger)
  const toolBuilder = new ToolBuilder(
    // 业务工具**为空**：AI 模块与业务模块解耦后的常态（`AGENT_TOOLS` 是扩展点）
    [],
    // core bean（规划 + 子 agent）：与 `ai.module.ts` 的装配口径一致
    [
      new PlannerCore(timelines),
      new SubAgentCore(runner, silentLogger),
      // 命令执行 core：与 `ai.module.ts` 的装配口径一致（assistant 已授权 run-command）
      new CommandCore(new CommandRunner(), config, silentLogger),
    ],
  )
  const registry = createAgentRegistry(
    createAgentDefinitions(createPromptEngine(), toolBuilder),
    DEFAULT_AGENT_KEY,
  )
  const mastra = await createMastra({
    // 模型改为"按 requestContext 解析"的动态参数；这些测试不验证选模型，给恒定 mock 模型
    resolveModel: () => ({ id: 'mock/mock-model', url: mock.baseURL, apiKey: 'test-key' }),
    definitions: registry.all(),
    resolveTools: (keys) => toolBuilder.build(keys),
    resolveSkills: (names) => new SkillLoader(silentLogger).resolve(names),
  })

  conversations = new AgentConversationService(conversationRepo, runs, timelines, registry, silentLogger)
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
    new SkillLoader(silentLogger),
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
      void chat
        .chatStream(USER, body as never, res)
        .catch((error: unknown) => {
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
    // 流式链路同样把 `todo-write` 的出参落成 `plan` 事件（与工具结果同一套保真口径）
    expect(kinds).toContain(TimelineKind.Plan)
    const planRow = page.items.find((item) => item.kind === TimelineKind.Plan)
    expect(planRow?.payload).toMatchObject({ revision: 1, goal: MOCK_TODO_INITIAL.goal })
    // 工具结果行也要认得出是哪个工具：AI SDK 的结果片段不带工具名（只有 toolCallId），
    // 录制器必须用入参那一步记下的名字补上（否则审计与 `plan` 识别都会失效）
    expect(page.items.find((item) => item.kind === TimelineKind.ToolResult)?.toolKey).toBe(
      MOCK_TODO_TOOL,
    )

    // 助手文本与工具结果都完整落库
    const assistantText = page.items
      .filter((item) => item.kind === TimelineKind.Text && item.role === 'assistant')
      .map((item) => String(item.payload?.text ?? ''))
      .join('')
    expect(assistantText).toContain(MOCK_FINAL_TEXT)

    const runRow = await db.dataSource.query<{ status: string; usage: unknown }[]>(
      'SELECT status, usage FROM runs WHERE conversation_id = $1',
      [conversationId],
    )
    expect(runRow[0]?.status).toBe(RunStatus.Succeeded)
    expect(runRow[0]?.usage).toBeTruthy()
    // 缓存命中**必须落到库里**（Mastra 放在顶层 `cachedInputTokens`，早先只读嵌套字段 → 永远是 null，
    // 用户看到"缓存命中没数"；mock 的 `prompt_tokens_details.cached_tokens = 64` 就是为这条链路加的）。
    // 数值口径：本轮是**两步**流程（先 todo-write 再回答）= 两次模型调用，mock 每次命中 64，
    // Mastra 把两次**累加**成 128；再加上**首轮自动命名**那次隔离调用（同样是 64）→ 192。
    // 命名调用**并进这一轮的 usage**（`runs.usage` 的语义就是"这一轮花掉的钱"，见设计文档 §4.10.1）。
    // 精确的字段优先级（顶层 64 胜过嵌套）由 `ai-usage.test.ts` 的纯函数单测钉住。
    expect(runRow[0]?.usage).toMatchObject({ cacheReadTokens: 192 })
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
})
