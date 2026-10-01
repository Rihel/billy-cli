import 'dotenv/config'
import { Db, setAuditUserProvider } from '@repo/kits'
import { AppErrorCodes } from '@repo/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConversationEntity } from '../src/database/entities/conversation-entity.js'
import { RunEntity } from '../src/database/entities/run-entity.js'
import { TimelineEntity } from '../src/database/entities/timeline-entity.js'
import { DEFAULT_AGENT_KEY, createAgentDefinitions } from '../src/modules/ai/agents/index.js'
import { createPromptEngine } from '../src/modules/ai/core/prompts/index.js'
import { createAgentRegistry } from '../src/modules/ai/agents/registry.js'
import { AgentService } from '../src/modules/ai/agents/service.js'
import type { AgentRegistry } from '../src/modules/ai/agents/types.js'
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
let registry: AgentRegistry

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

  registry = createAgentRegistry(
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

  /**
   * 兜底：有些会话是经 HTTP / 流式端点建的、**没进 `createdConversationIds`** ——
   * 按测试用户再扫一遍。不扫的代价很实在：`DB_URL` 指向哪个库就往哪儿写，开发机上就是开发库，
   * 每跑一次测试都会多出一堆"看着像真会话"的假数据（还会出现在会话页侧栏里）。
   */
  for (const userId of [USER, OTHER_USER]) {
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
        toolKey: 'plan-create',
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
    expect(page.items[2].toolKey).toBe('plan-create')
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

describe('会话重命名（用户手动改名）', () => {
  it('改名成功：详情立刻是新名字，并留一条审计事件（谁把什么改成了什么）', async () => {
    const conversation = await conversationService.create(USER, {})
    createdConversationIds.push(conversation.id)

    const renamed = await conversationService.rename(USER, {
      conversationId: conversation.id,
      title: '缓存穿透排查',
    })
    expect(renamed.title).toBe('缓存穿透排查')
    expect(
      (await conversationService.detail(USER, { conversationId: conversation.id })).title,
    ).toBe('缓存穿透排查')

    // 改名会改变用户可见状态 → 必须留痕（与删除会话同一口径）
    const rows = await db.dataSource.query<
      { payload: Record<string, unknown> }[]
    >("SELECT payload FROM timelines WHERE conversation_id = $1 AND kind = 'status'", [
      conversation.id,
    ])
    expect(rows[0]?.payload).toMatchObject({
      reason: 'conversation_renamed',
      from: '',
      to: '缓存穿透排查',
      operator: USER,
    })
  })

  it('名字没变：不写库也不记事件（避免"点开又确认"刷出一条无意义的审计）', async () => {
    const conversation = await conversationService.create(USER, { title: '老名字' })
    createdConversationIds.push(conversation.id)

    await conversationService.rename(USER, {
      conversationId: conversation.id,
      title: '老名字',
    })
    const rows = await db.dataSource.query<{ count: string }[]>(
      "SELECT count(*)::text AS count FROM timelines WHERE conversation_id = $1 AND kind = 'status'",
      [conversation.id],
    )
    expect(rows[0]?.count).toBe('0')
  })

  it('改别人的会话：3304（不存在与不属于自己返回同一个错，避免被用来探测）', async () => {
    const conversation = await conversationService.create(USER, {})
    createdConversationIds.push(conversation.id)

    await expect(
      conversationService.rename(OTHER_USER, {
        conversationId: conversation.id,
        title: '偷改',
      }),
    ).rejects.toMatchObject({ code: AppErrorCodes.ConversationNotFound })
  })
})

describe('查看系统指令（前端「查看系统指令」的数据源）', () => {
  it('返回装配期渲染好的原文：与真正挂上去的那份是同一个字符串，不另存副本', () => {
    // MASTRA / 模型服务与"读系统指令"无关：给 null / 替身即可（这条路径只碰注册表）
    const service = new AgentService(null, registry, {} as never)

    const result = service.instructions({})
    expect(result.agentKey).toBe(DEFAULT_AGENT_KEY)
    expect(result.name).toBeTruthy()
    // 四段结构（角色 / 要求 / 工具 / 原则）都在，且工具清单来自**实际授权**（不是手抄）
    expect(result.instructions).toContain('# 角色')
    expect(result.instructions).toContain('# 要求')
    expect(result.instructions).toContain('# 工具')
    expect(result.instructions).toContain('# 原则')
    // 工具清单来自**实际授权**（规划工具集是当前 core bean 交出的能力）
    expect(result.instructions).toContain('plan-create')
  })

  it('未注册的 agentKey：3303，**不静默回落**成默认 agent（否则会让人看错对象）', () => {
    const service = new AgentService(null, registry, {} as never)
    expect(() => service.instructions({ agentKey: 'not-exists' })).toThrowError(
      expect.objectContaining({ code: AppErrorCodes.AgentNotFound }),
    )
  })
})
