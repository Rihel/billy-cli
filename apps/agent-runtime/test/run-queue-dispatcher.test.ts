import 'dotenv/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Db, IdGeneration, PubSub, RedisStore, setAuditUserProvider } from '@repo/kits'
import { RunStatus, TimelineKind, TimelineRole, agentStreamChannel } from '@repo/shared'
import { ConversationEntity, ConversationRunQueueEntity, RunEntity, TimelineEntity } from '@repo/db'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from '../src/modules/ai/agents/index.js'
import { createAgentRegistry } from '../src/modules/ai/agents/registry.js'
import { createPromptEngine } from '../src/modules/ai/core/prompts/index.js'
import { createMastra } from '../src/modules/ai/mastra/ai.mastra.js'
import { toMastraTools } from '../src/modules/ai/mastra/tool.adapter.js'
import { toMastraSkills } from '../src/modules/ai/mastra/skill.adapter.js'
import { SkillLoader } from '../src/modules/ai/core/skills/index.js'
import { ToolGateway } from '../src/modules/ai/core/tools/tool.gateway.js'
import { ToolRegistry } from '../src/modules/ai/core/tools/tool.registry.js'
import { FileTools } from '../src/modules/ai/files/file.tools.js'
import { WebTools } from '../src/modules/ai/tools/web.tools.js'
import { ReadToolResultTool } from '../src/modules/ai/tools/read-tool-result.tool.js'
import { RunSubAgentTool } from '../src/modules/ai/tools/subagent.tool.js'
import { PlannerStore, PlannerTools } from '../src/modules/ai/tools/planner/index.js'
import { AgentRunner } from '../src/modules/ai/runtime/agent-runner.js'
import {
  AgentChatService,
  type StreamResponseLike,
} from '../src/modules/ai/runtime/chat.service.js'
import { AgentConversationService } from '../src/modules/ai/runtime/conversation.service.js'
import { ConversationRepository } from '../src/modules/ai/runtime/conversation.repository.js'
import { ContextService } from '../src/modules/ai/runtime/context.service.js'
import { RunRepository } from '../src/modules/ai/runtime/run.repository.js'
import { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'
import { ConversationRunQueue } from '../src/modules/ai/runtime/run-queue.service.js'
import { ConversationRunQueueDispatcher } from '../src/modules/ai/runtime/run-queue.dispatcher.js'
import { AgentStreamStore } from '../src/modules/ai/runtime/stream-store.service.js'
import { AgentTitleService } from '../src/modules/ai/runtime/title.service.js'
import { buildToolStackDeps, makeBashTool } from './helpers/ai-tool-stack.js'
import { stubAttachments } from './helpers/attachments.js'
import {
  MOCK_FINAL_TEXT,
  startMockModelServer,
  type MockModelServer,
} from './helpers/mock-model-server.js'

/**
 * 异步子 agent 的「唤醒 dispatcher + 用户消息排队」集成测试：假模型 + 真实 DB + 真实 Redis。
 *
 * 覆盖设计 `docs/design/async-subagent.md` 的关键口径：
 * - 子 agent 完成入队 → dispatcher 取队首 → 父会话新建 `origin='subagent'` 的 root run；
 * - 时间线**先写系统卡**，再是父的正常回复；模型收到的收尾消息是 **system 内部通知**（不是用户消息）；
 * - 用户消息优先于子 agent 唤醒；同一会话串行；
 * - 会话忙时 `chatStream` **入队**（回 `data-queue`），不再 3306；
 * - dedupe（subRunId）只唤醒一次；
 * - stop → 级联取消子 run 与待唤醒队列项。
 */

const USER = 'user_ai_run_queue'
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/15'

const silentLogger = {
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

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
  commandEnabled: false,
  commandTimeoutMs: 5_000,
  commandMaxOutputBytes: 64 * 1024,
} as never

let db: Db
let redis: RedisStore
let pubsub: PubSub
let mock: MockModelServer
let chat: AgentChatService
let conversations: AgentConversationService
let conversationRepo: ConversationRepository
let runs: RunRepository
let timelines: TimelineRepository
let queue: ConversationRunQueue
let runner: AgentRunner
let dispatcher: ConversationRunQueueDispatcher
/** `conversation.run.started` 事件（验证"新 run 启动时通知前端续流"） */
const startedEvents: Array<{ conversationId: string; runId: string; origin: string }> = []
const createdConversationIds: string[] = []

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('等待超时：条件未在预期时间内成立')
}

/** 假 SSE 响应：只收集写出的帧（chatStream 的排队应答不需要真 socket） */
const fakeResponse = (): StreamResponseLike & { chunks: string[] } => {
  const response = {
    chunks: [] as string[],
    writableEnded: false,
    writeHead: () => undefined,
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      response.chunks.push(chunk)
      return true
    },
    end: () => {
      response.writableEnded = true
    },
    on: () => undefined,
  }
  return response
}

const chunksOf = (
  sse: string,
): Array<{ type?: string; id?: string; data?: Record<string, unknown> }> =>
  sse
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)) as { type?: string; data?: Record<string, unknown> })

beforeAll(async () => {
  mock = await startMockModelServer()
  db = new Db(
    {
      url: process.env.DB_URL!,
      sync: false,
      entities: [ConversationEntity, RunEntity, TimelineEntity, ConversationRunQueueEntity],
    } as never,
    silentLogger,
  )
  await db.onApplicationBootstrap()
  if (!db.dataSource.isInitialized) throw new Error('数据库初始化失败')

  redis = new RedisStore(
    { url: REDIS_URL, keyPrefix: 'aitest:' } as never,
    new IdGeneration(),
    silentLogger,
  )
  await redis.onApplicationBootstrap()

  const modelsStub = {
    resolveForRuntime: async () => ({
      id: 'model_mock',
      modelRef: 'mock/mock-model',
      modelKey: 'mock-model',
      displayName: 'Mock 模型',
      baseURL: mock.baseURL,
      apiKey: 'test-key',
      contextWindow: null,
      mode: 'chat',
      inputModalities: null,
    }),
  } as never

  conversationRepo = new ConversationRepository(db)
  runs = new RunRepository(db, { changed: async () => {} })
  timelines = new TimelineRepository(db)
  pubsub = new PubSub({ url: REDIS_URL } as never, new IdGeneration(), silentLogger)
  const streamStore = new AgentStreamStore(redis, silentLogger, pubsub)
  queue = new ConversationRunQueue(db, redis, silentLogger)

  const config = { ...TEST_CONFIG, baseURL: mock.baseURL } as never
  const deps = buildToolStackDeps()
  const gateway = new ToolGateway(deps.config, silentLogger, [], deps.clock)
  let toolRegistry: ToolRegistry
  const moduleRefPort = { get: () => toolRegistry } as never
  runner = new AgentRunner(
    runs,
    timelines,
    config,
    silentLogger,
    deps.metas,
    moduleRefPort,
    conversationRepo,
    undefined,
    undefined,
    // 异步子 agent 完成 → 父会话唤醒队列（被测链路的关键接线）
    queue,
  )
  toolRegistry = new ToolRegistry(
    [
      makeBashTool(silentLogger),
      new WebTools(silentLogger as never),
      new FileTools({} as never, { enabled: true } as never),
      new RunSubAgentTool(runner, silentLogger),
      new PlannerTools(new PlannerStore(timelines)),
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
  const runEventsStub = {
    started: async (conversationId: string, runId: string, origin: string) => {
      startedEvents.push({ conversationId, runId, origin })
    },
    changed: async () => undefined,
  }

  chat = new AgentChatService(
    mastra,
    registry,
    config,
    conversations,
    conversationRepo,
    runs,
    timelines,
    context,
    stubAttachments(silentLogger),
    streamStore,
    toolRegistry,
    deps.metas,
    skillLoader,
    modelsStub,
    silentLogger,
    createPromptEngine(),
    new AgentTitleService(timelines, createPromptEngine(), silentLogger),
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    queue,
    runEventsStub as never,
  )
  dispatcher = new ConversationRunQueueDispatcher(queue, runs, chat, silentLogger)
  setAuditUserProvider(() => USER)
})

afterAll(async () => {
  setAuditUserProvider(undefined)
  for (const id of createdConversationIds) {
    await db.dataSource.query('DELETE FROM conversation_run_queue WHERE conversation_id = $1', [id])
    await db.dataSource.query('DELETE FROM timelines WHERE conversation_id = $1', [id])
    await db.dataSource.query('DELETE FROM runs WHERE conversation_id = $1', [id])
    await db.dataSource.query('DELETE FROM conversations WHERE id = $1', [id])
  }
  for (const userId of [USER]) {
    await db.dataSource.query(
      `DELETE FROM conversation_run_queue WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = $1)`,
      [userId],
    )
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
  await pubsub.onApplicationShutdown()
  await redis.onApplicationShutdown()
  await db.onApplicationShutdown()
  await mock.close()
})

/** 建测试会话（进清理表） */
const createConversation = async (): Promise<string> => {
  const created = await conversations.create(USER, {} as never)
  createdConversationIds.push(created.id)
  return created.id
}

/** 造一条"用户已经在跑"的根 run（模拟上一轮未结束） */
const seedActiveRun = async (conversationId: string): Promise<string> => {
  const run = await runs.create({
    conversationId,
    agentKey: DEFAULT_AGENT_KEY,
    status: RunStatus.Pending,
    triggeredBy: USER,
  })
  await runs.markRunning(run.id, `eng_${run.id}`)
  return run.id
}

const seedWakeItem = async (
  conversationId: string,
  overrides: {
    subRunId?: string
    name?: string
    result?: string
    progress?: { total: number; completed: number; pending: string[] }
    resultPath?: string
    resultBytes?: number
    resultLines?: number
  } = {},
) => {
  const subRunId = overrides.subRunId ?? `subrun_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const subAgentId = `subconv_${subRunId.slice(-10)}`
  const item = await queue.enqueue({
    conversationId,
    source: 'subagent',
    dedupeKey: subRunId,
    payload: {
      subAgentId,
      subRunId,
      name: overrides.name ?? '待办统计',
      status: 'succeeded',
      result: overrides.result ?? '共 3 条待办：A、B、C',
      error: null,
      isAdmin: false,
      resultPath: overrides.resultPath ?? 'subagents/待办统计-x.md',
      resultBytes: overrides.resultBytes ?? 2048,
      resultLines: overrides.resultLines ?? 42,
      ...(overrides.progress ? { progress: overrides.progress } : {}),
    },
  })
  return { item, subRunId, subAgentId }
}

describe('异步子 agent 唤醒 dispatcher（真实 DB + 假模型）', () => {
  it('子 agent 完成队列项 → 父会话新建 origin=subagent 的 run，先系统卡后回复', async () => {
    const conversationId = await createConversation()
    // 逐个唤醒 + 同批进度：通知里要写清「还有谁在跑」，父 agent 不用自己数
    const { item, subRunId } = await seedWakeItem(conversationId, {
      progress: { total: 2, completed: 1, pending: ['背景口碑'] },
    })

    // tick 扫到这一条（真实入口），跑完由 dispatcher 收尾
    const started = await dispatcher.tick([conversationId])
    expect(started).toBeGreaterThanOrEqual(1)
    await waitFor(async () => (await queue.findByDedupe(subRunId))?.status === 'done')

    const claimed = await queue.findByDedupe(subRunId)
    expect(claimed?.id).toBe(item.id)
    expect(claimed?.runId).toBeTruthy()

    // 新 root run：origin=subagent、parentRunId=null、成功收尾
    const wakeRun = await runs.findEntity(claimed!.runId!)
    expect(wakeRun?.parentRunId).toBeNull()
    expect(wakeRun?.origin).toBe('subagent')
    expect(wakeRun?.status).toBe(RunStatus.Succeeded)
    expect(wakeRun?.requestSnapshot).toMatchObject({
      origin: 'subagent',
      queue: { source: 'subagent', dedupeKey: subRunId },
    })

    // 时间线：系统卡在前，assistant 回复在后；**没有伪造用户消息**
    const page = await timelines.list({ conversationId, page: 1, size: 100 })
    const own = page.items.filter((row) => row.runId === wakeRun!.id)
    const card = own.find(
      (row) => row.kind === TimelineKind.Status && row.payload?.status === 'subagent_completed',
    )
    const reply = own.find(
      (row) =>
        row.kind === TimelineKind.Text &&
        row.role === TimelineRole.Assistant &&
        typeof row.payload?.text === 'string',
    )
    expect(card).toBeTruthy()
    expect(card?.payload?.subRunId).toBe(subRunId)
    expect(card?.payload?.name).toBe('待办统计')
    expect(reply).toBeTruthy()
    expect((reply!.payload!.text as string).length).toBeGreaterThan(0)
    expect(card!.seq).toBeLessThan(reply!.seq)
    expect(
      own.some((row) => row.kind === TimelineKind.Text && row.role === TimelineRole.User),
    ).toBe(false)

    // 模型收到的收尾消息是**内部系统通知**：角色走 user（模型只认最后一条 user 当本轮任务），
    // 但文案首尾都写明「不是用户的新消息」
    const request = mock.requests.at(-1)
    const messages = (request?.messages ?? []) as Array<{ role?: string; content?: unknown }>
    const notice = JSON.stringify(messages)
    expect(notice).toContain('子 agent「待办统计」已完成')
    // 通知不再贴全文，只给文件引用 + 大小 / 行数（正文让模型自己 read-file 读）
    expect(notice).toContain('subagents/待办统计-x.md')
    expect(notice).toContain('42 行')
    expect(notice).toContain('2 KB')
    expect(notice).not.toContain('共 3 条待办')
    expect(notice).toContain('内部系统通知')
    // 同批进度：还有 1 个在跑（背景口碑），并明确「全部到齐后再汇总」
    expect(notice).toContain('还有 1 个在跑（背景口碑）')
    expect(notice).toContain('全部到齐后再做最终汇总')
    expect(
      messages.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message).includes('不是用户的新消息') &&
          JSON.stringify(message).includes('不要把这当成「用户重复提问」'),
      ),
    ).toBe(true)

    // run.started 事件（前端自动续流）
    expect(
      startedEvents.some((event) => event.runId === wakeRun!.id && event.origin === 'subagent'),
    ).toBe(true)
  })

  it('用户消息优先于子 agent 唤醒；同一会话串行', async () => {
    const conversationId = await createConversation()
    const activeRunId = await seedActiveRun(conversationId)
    const { subRunId } = await seedWakeItem(conversationId, { name: '后台整理' })
    const userItem = await queue.enqueue({
      conversationId,
      source: 'user',
      payload: { message: '帮我看看最近有哪些待办', isAdmin: false },
    })

    // 会话忙：不取队首
    expect(await dispatcher.dispatch(conversationId)).toBe(false)
    expect((await queue.findByDedupe(subRunId))?.status).toBe('queued')

    // 上一轮结束 → 先跑用户项（priority 0），再跑子 agent 唤醒（priority 1）
    await runs.finish(activeRunId, { status: RunStatus.Succeeded })
    expect(await dispatcher.dispatch(conversationId)).toBe(true)
    const userRow = await db
      .getRepository(ConversationRunQueueEntity)
      .findOneBy({ id: userItem.id })
    expect(userRow?.status).toBe('done')
    expect((await queue.findByDedupe(subRunId))?.status).toBe('queued')

    expect(await dispatcher.dispatch(conversationId)).toBe(true)
    expect((await queue.findByDedupe(subRunId))?.status).toBe('done')

    // 两条 run 的先后：用户消息的 run 先建（origin=user），唤醒 run 后建（origin=subagent）
    const all = await db.getRepository(RunEntity).find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
    })
    const userRun = all.find((run) => run.origin === 'user' && run.id !== activeRunId)
    const wakeRun = all.find((run) => run.origin === 'subagent')
    expect(userRun).toBeTruthy()
    expect(wakeRun).toBeTruthy()
    expect(userRun!.createdAt.getTime()).toBeLessThanOrEqual(wakeRun!.createdAt.getTime())

    // 用户那一轮照常落用户消息 + 助手回复
    const page = await timelines.list({ conversationId, page: 1, size: 100 })
    expect(
      page.items.some(
        (row) =>
          row.runId === userRun!.id &&
          row.kind === TimelineKind.Text &&
          row.role === TimelineRole.User &&
          row.payload?.text === '帮我看看最近有哪些待办',
      ),
    ).toBe(true)
  })

  it('dedupe：同一个 subRunId 重复入队只唤醒一次', async () => {
    const conversationId = await createConversation()
    const { item, subRunId } = await seedWakeItem(conversationId)
    const dup = await seedWakeItem(conversationId, { subRunId })
    expect(dup.item.id).toBe(item.id)

    await dispatcher.dispatch(conversationId)
    const runsOfConversation = await db.getRepository(RunEntity).find({
      where: { conversationId },
    })
    const wakeRuns = runsOfConversation.filter((run) => run.origin === 'subagent')
    expect(wakeRuns).toHaveLength(1)
    expect((await queue.findByDedupe(subRunId))?.status).toBe('done')

    // 已完成的再入队：dedupe 命中同一行（不会重新唤醒）
    const again = await seedWakeItem(conversationId, { subRunId })
    expect(again.item.id).toBe(item.id)
    expect(await dispatcher.dispatch(conversationId)).toBe(false)
  })

  it('chatStream 会话忙时入队（不再 3306），调度后正常落用户消息与回复', async () => {
    const conversationId = await createConversation()
    const activeRunId = await seedActiveRun(conversationId)

    const response = fakeResponse()
    await chat.chatStream(USER, { conversationId, message: '排队中的用户消息' } as never, response)
    const sse = response.chunks.join('')
    expect(sse).toContain('data-queue')
    const facts = chunksOf(sse)
    expect(facts.find((chunk) => chunk.type === 'data-queue')?.data?.queued).toBe(true)
    expect(sse).toContain('data: [DONE]')

    const pending = await db.getRepository(ConversationRunQueueEntity).find({
      where: { conversationId, source: 'user' },
    })
    expect(pending).toHaveLength(1)
    expect(pending[0].priority).toBe(0)

    // 上一轮跑完 → dispatcher 执行排队的用户消息（同一 HTTP 连接已结束，靠 run.started 续流）
    await runs.finish(activeRunId, { status: RunStatus.Succeeded })
    expect(await dispatcher.dispatch(conversationId)).toBe(true)
    const done = await db.getRepository(ConversationRunQueueEntity).findOneBy({ id: pending[0].id })
    expect(done?.status).toBe('done')
    expect(done?.runId).toBeTruthy()

    const queuedRun = await runs.findEntity(done!.runId!)
    expect(queuedRun?.origin).toBe('user')
    expect(queuedRun?.status).toBe(RunStatus.Succeeded)
    const page = await timelines.list({ conversationId, page: 1, size: 100 })
    expect(
      page.items.some(
        (row) =>
          row.runId === queuedRun!.id &&
          row.kind === TimelineKind.Text &&
          row.role === TimelineRole.User &&
          row.payload?.text === '排队中的用户消息',
      ),
    ).toBe(true)
    expect(
      page.items.some(
        (row) =>
          row.runId === queuedRun!.id &&
          row.kind === TimelineKind.Text &&
          row.role === TimelineRole.Assistant,
      ),
    ).toBe(true)
    expect(
      startedEvents.some((event) => event.runId === queuedRun!.id && event.origin === 'user'),
    ).toBe(true)
  })

  it('run-sub-agent 异步完成 → 自动入队（source=subagent），dispatcher 再唤醒父会话', async () => {
    const conversationId = await createConversation()
    const parentRunId = await seedActiveRun(conversationId)
    const model = {
      id: 'model_mock',
      modelRef: 'mock/mock-model',
      modelKey: 'mock-model',
      displayName: 'Mock 模型',
      providerKind: 'openai-compatible',
      baseURL: mock.baseURL,
      apiKey: 'test-key',
      contextWindow: null,
      inputModalities: null,
    }
    const envelope = {
      conversationId,
      workspaceConversationId: conversationId,
      parentRunId,
      triggeredBy: USER,
      isAdmin: false,
      fileAccess: 'workspace-write',
      depth: 0,
      agentKey: DEFAULT_AGENT_KEY,
      rootAgentKey: DEFAULT_AGENT_KEY,
      model,
      childToolbox: new Map(),
      skills: [],
    } as never

    const spawned = await runner.spawnSubAgent({
      name: '异步核对',
      systemPrompt: '你是核对助手，只输出一句话核对结论。',
      task: '核对 1+1=2，给一句话结论。',
      toolCallId: `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      envelope,
    })

    // 子 run 跑完 → AgentRunner 把"完成"写进父会话队列（dedupe = subRunId）
    await waitFor(async () => {
      const child = await runs.findEntity(spawned.subRunId)
      if (child?.status !== RunStatus.Succeeded) return false
      return (await queue.findByDedupe(spawned.subRunId)) !== null
    })
    const queued = await queue.findByDedupe(spawned.subRunId)
    expect(queued?.conversationId).toBe(conversationId)
    expect(queued?.source).toBe('subagent')
    expect(queued?.priority).toBe(1)
    expect(queued?.payload).toMatchObject({
      subAgentId: spawned.subAgentId,
      subRunId: spawned.subRunId,
      name: '异步核对',
      status: 'succeeded',
    })

    // 父这一轮正常结束 → dispatcher 唤醒父会话（origin=subagent）
    await runs.finish(parentRunId, { status: RunStatus.Succeeded })
    expect(await dispatcher.dispatch(conversationId)).toBe(true)
    const wakeRun = (await db.getRepository(RunEntity).find({ where: { conversationId } })).find(
      (run) => run.origin === 'subagent',
    )
    expect(wakeRun).toBeTruthy()
    expect(wakeRun?.parentRunId).toBeNull()
  })

  it('stop：级联取消子 run 与待唤醒队列项（用户消息不动）', async () => {
    const conversationId = await createConversation()
    const parentRunId = await seedActiveRun(conversationId)

    const parent = await conversationRepo.findEntity(conversationId)
    expect(parent).toBeTruthy()
    const childConversation = await conversationRepo.ensureSubagent({
      parent: parent!,
      name: '被取消的子助手',
      agentKey: 'sub:被取消的子助手',
      depth: 1,
      originRunId: parentRunId,
      originToolCallId: null,
    })
    createdConversationIds.push(childConversation.id)
    const childRun = await runs.create({
      conversationId: childConversation.id,
      agentKey: 'sub:被取消的子助手',
      status: RunStatus.Pending,
      parentRunId,
      depth: 1,
    })
    await runs.markRunning(childRun.id, `eng_${childRun.id}`)

    await seedWakeItem(childConversation.id, { subRunId: childRun.id })
    const userItem = await queue.enqueue({
      conversationId,
      source: 'user',
      payload: { message: '这条不该被 stop 取消', isAdmin: false },
    })

    await chat.stopRun(USER, parentRunId)

    const child = await runs.findEntity(childRun.id)
    expect(child?.status).toBe(RunStatus.Canceled)
    expect((await queue.findByDedupe(childRun.id))?.status).toBe('canceled')
    const userRow = await db
      .getRepository(ConversationRunQueueEntity)
      .findOneBy({ id: userItem.id })
    expect(userRow?.status).toBe('queued')
  })
})

describe('排队应答的定向通道（防回归）', () => {
  it('publishControl：先发 data-queue 帧，再单独发 final 帧（main 的桥只认后者收尾）', async () => {
    // 用独立的 PubSub 模拟 main 侧订阅（同一实例会被自回环过滤掉，收不到自己发的帧）
    const listener = new PubSub({ url: REDIS_URL } as never, new IdGeneration(), silentLogger)
    const frames: Array<Record<string, unknown>> = []
    const unsubscribe = await listener.subscribeAsync(agentStreamChannel('client_1'), (payload) => {
      frames.push(payload as Record<string, unknown>)
    })
    try {
      const store = new AgentStreamStore(redis, silentLogger, pubsub)
      await store.publishControl(
        { clientId: 'client_1', runId: 'queue_1' },
        { type: 'data-queue', data: { queued: true } },
      )
      await waitFor(async () => frames.length >= 2)
      expect(frames).toHaveLength(2)
      expect(frames[0]).toMatchObject({
        runId: 'queue_1',
        final: false,
        chunk: { type: 'data-queue' },
      })
      // final 帧的 chunk 不会被 main 转发：它只负责写 [DONE] 并结束响应
      expect(frames[1]).toMatchObject({ final: true, chunk: { type: '__run_end__' } })
    } finally {
      unsubscribe()
      await listener.onApplicationShutdown()
    }
  })
})

describe('响应与数据形状（防回归）', () => {
  it('唤醒 run 的 request_snapshot 带 subAgent 卡片证据', async () => {
    const conversationId = await createConversation()
    await seedWakeItem(conversationId, { name: '证据检查' })
    await dispatcher.dispatch(conversationId)
    const wakeRun = (await db.getRepository(RunEntity).find({ where: { conversationId } })).find(
      (run) => run.origin === 'subagent',
    )
    expect(wakeRun?.requestSnapshot).toMatchObject({
      subAgent: { name: '证据检查', status: 'subagent_completed' },
    })
    expect(MOCK_FINAL_TEXT.length).toBeGreaterThan(0)
  })
})
