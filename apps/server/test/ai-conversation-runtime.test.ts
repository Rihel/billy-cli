import 'dotenv/config'
import { Db, setAuditUserProvider } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConversationEntity } from '../src/database/entities/conversation-entity.js'
import { RunEntity } from '../src/database/entities/run-entity.js'
import { TimelineEntity } from '../src/database/entities/timeline-entity.js'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from '../src/modules/ai/agents/index.js'
import { createPromptEngine } from '../src/modules/ai/prompts/index.js'
import { createAgentRegistry } from '../src/modules/ai/core/ai.registry.js'
import { AgentConversationService } from '../src/modules/ai/runtime/conversation.service.js'
import { ConversationRepository } from '../src/modules/ai/runtime/conversation.repository.js'
import { RunRepository } from '../src/modules/ai/runtime/run.repository.js'
import { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'
import { AgentTimelineService } from '../src/modules/ai/runtime/timeline.service.js'

/**
 * 会话运行时的集成测试：**打真实数据库**（本地 Postgres），不碰模型与 Redis。
 *
 * 覆盖的是"读链路是否成立 + 设计里的硬规则是否真被守住"：
 * 归属校验（3304）、只能软删会话、软删前先结束在跑的运行、时间线按 seq 升序、
 * 审计列（deleted_by）真的被写上。
 *
 * 前置：`apps/server/.env` 里的 DB_URL 指向可用库，且已执行迁移。
 */

const USER = 'user_ai_test_1'
const OTHER_USER = 'user_ai_test_2'

const dbErrors: unknown[] = []
const silentLogger = {
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  // Db.connect 会吞掉初始化异常并只记日志 —— 测试里必须把它捞出来，否则只会看到"没有元数据"
  error: (...args: unknown[]) => dbErrors.push(args),
  debug: () => undefined,
} as never

let db: Db
let conversations: ConversationRepository
let runs: RunRepository
let timelines: TimelineRepository
let conversationService: AgentConversationService
let timelineService: AgentTimelineService

/** 测试造的会话 id（结束时清理） */
const createdConversationIds: string[] = []

beforeAll(async () => {
  db = new Db(
    {
      url: process.env.DB_URL!,
      sync: false,
      entities: [ConversationEntity, RunEntity, TimelineEntity],
    } as never,
    silentLogger,
  )
  await db.onApplicationBootstrap()
  if (!db.dataSource.isInitialized) {
    throw new Error(`数据库初始化失败：${JSON.stringify(dbErrors)}`)
  }

  conversations = new ConversationRepository(db)
  runs = new RunRepository(db)
  timelines = new TimelineRepository(db)

  const registry = createAgentRegistry(
    createAgentDefinitions(createPromptEngine(), {
      describe: (keys: readonly string[]) =>
        keys.map((key) => ({ key, title: key, description: key })),
    } as never),
    DEFAULT_AGENT_KEY,
  )
  conversationService = new AgentConversationService(
    conversations,
    runs,
    timelines,
    registry,
    silentLogger,
  )
  timelineService = new AgentTimelineService(timelines, conversationService)

  // 审计操作人：模拟"登录用户 u_test"发起的写操作（验证审计列真的落上）
  setAuditUserProvider(() => USER)
})

afterAll(async () => {
  setAuditUserProvider(undefined)
  // 清理测试数据（物理删，避免污染开发库）
  for (const id of createdConversationIds) {
    await db.dataSource.query('DELETE FROM timelines WHERE conversation_id = $1', [id])
    await db.dataSource.query('DELETE FROM runs WHERE conversation_id = $1', [id])
    await db.dataSource.query('DELETE FROM conversations WHERE id = $1', [id])
  }
  await db.onApplicationShutdown()
})

describe('会话运行时（真实数据库）', () => {
  it('建会话：agentKey 落到会话上，计数从 0 开始', async () => {
    const conversation = await conversationService.create(USER, {})
    createdConversationIds.push(conversation.id)

    expect(conversation.agentKey).toBe(DEFAULT_AGENT_KEY)
    expect(conversation.turnCount).toBe(0)
    expect(conversation.totalTokens).toBe(0)
    expect(conversation.title).toBe('')
  })

  it('未知 agentKey → 3303（装配期就该拦住的那种）', async () => {
    await expect(
      conversationService.create(USER, { agentKey: 'nope' }),
    ).rejects.toMatchObject({ code: AppErrorCodes.AgentNotFound })
  })

  it('列表只返回自己的会话', async () => {
    const mine = await conversationService.list(USER, { page: 1, size: 20, includeDeleted: false })
    const others = await conversationService.list(OTHER_USER, {
      page: 1,
      size: 20,
      includeDeleted: false,
    })
    expect(mine.total).toBeGreaterThanOrEqual(1)
    expect(others.total).toBe(0)
  })

  it('别人的会话：detail 返回 3304（不区分"不存在"与"不是你的"）', async () => {
    const conversation = await conversationService.create(USER, {})
    createdConversationIds.push(conversation.id)

    await expect(
      conversationService.detail(OTHER_USER, { conversationId: conversation.id }),
    ).rejects.toMatchObject({ code: AppErrorCodes.ConversationNotFound })
  })

  it('时间线：seq 单调递增，按 seq 升序返回', async () => {
    const conversation = await conversationService.create(USER, {})
    createdConversationIds.push(conversation.id)

    await timelines.appendMany([
      { conversationId: conversation.id, role: 'user', kind: 'text', payload: { text: '第一句' } },
      { conversationId: conversation.id, role: 'assistant', kind: 'text', payload: { text: '第二句' } },
      {
        conversationId: conversation.id,
        role: 'assistant',
        kind: 'tool-result',
        toolKey: 'get-todo',
        toolCallId: 'call_test_1',
        payload: { output: { title: '完整出参不裁剪' } },
      },
    ])

    const page = await timelineService.list(USER, {
      conversationId: conversation.id,
      page: 1,
      size: 50,
    })
    expect(page.total).toBe(3)
    expect(page.items.map((item) => item.seq)).toEqual([1, 2, 3])
    expect(page.items[2].toolKey).toBe('get-todo')
    // 保真：工具出参原样可读
    expect(page.items[2].payload).toEqual({ output: { title: '完整出参不裁剪' } })
  })

  it('软删会话：先结束在跑的运行、写审计列、之后 detail 返回 3304、includeDeleted 能看到', async () => {
    const conversation = await conversationService.create(USER, {})
    createdConversationIds.push(conversation.id)

    const run = await runs.create({
      conversationId: conversation.id,
      agentKey: DEFAULT_AGENT_KEY,
      status: 'running',
      triggeredBy: USER,
    })

    await conversationService.remove(USER, { conversationId: conversation.id })

    // 1) 在跑的运行被结束
    const finished = await runs.findEntity(run.id)
    expect(finished?.status).toBe('canceled')
    expect(finished?.finishedAt).not.toBeNull()

    // 2) 软删后业务侧查不到（3304）
    await expect(
      conversationService.detail(USER, { conversationId: conversation.id }),
    ).rejects.toMatchObject({ code: AppErrorCodes.ConversationNotFound })

    // 3) 数据仍在，且审计操作人写上了（不是物理删除）
    const rows = await db.dataSource.query<
      { deleted_at: Date | null; deleted_by: string | null; id: string }[]
    >('SELECT id, deleted_at, deleted_by FROM conversations WHERE id = $1', [conversation.id])
    expect(rows[0]?.deleted_at).not.toBeNull()
    expect(rows[0]?.deleted_by).toBe(USER)

    // 4) 时间线里留下了"谁因为什么结束了运行"的状态事件（审计证据）
    const auditTimeline = await db.dataSource.query<
      { kind: string; payload: Record<string, unknown> }[]
    >("SELECT kind, payload FROM timelines WHERE conversation_id = $1 AND kind = 'status'", [
      conversation.id,
    ])
    expect(auditTimeline[0]?.payload).toMatchObject({
      status: 'canceled',
      reason: 'conversation_removed',
      operator: USER,
    })
  })
})
