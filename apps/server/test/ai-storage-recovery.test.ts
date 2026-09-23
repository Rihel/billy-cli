import 'dotenv/config'
import { Db, setAuditUserProvider } from '@repo/kits'
import { RunStatus, TimelineKind } from '@repo/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConversationEntity } from '../src/database/entities/conversation-entity.js'
import { RunEntity } from '../src/database/entities/run-entity.js'
import { TimelineEntity } from '../src/database/entities/timeline-entity.js'
import type { AgentConfig as AgentConfigValue } from '../src/modules/ai/core/ai.config.js'
import { AgentMastraStore } from '../src/modules/ai/runtime/storage/agent-mastra-store.js'
import { AgentRecoveryService } from '../src/modules/ai/runtime/recovery.service.js'
import { AgentConversationService } from '../src/modules/ai/runtime/conversation.service.js'
import { ConversationRepository } from '../src/modules/ai/runtime/conversation.repository.js'
import { RunRepository } from '../src/modules/ai/runtime/run.repository.js'
import { TimelineRepository } from '../src/modules/ai/runtime/timeline.repository.js'
import { DEFAULT_AGENT_KEY } from '../src/modules/ai/agents/index.js'
import { createAgentDefinitions } from '../src/modules/ai/agents/index.js'
import { createPromptEngine } from '../src/modules/ai/prompts/index.js'
import { createAgentRegistry } from '../src/modules/ai/core/ai.registry.js'

/**
 * 存储适配层与恢复：**真实数据库**，不依赖模型。
 *
 * 覆盖设计文档里两条硬要求：
 * - 快照落我们自己的表（往返一致），且**运行记录不提供删除**（delete/clear 都是 no-op）；
 * - 看门狗用**条件 UPDATE 抢执行权**标记卡死的运行（多副本并行也只有一条会被处置）。
 */

const USER = 'user_ai_recovery'
const silentLogger = {
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

let db: Db
let runs: RunRepository
let timelines: TimelineRepository
let conversations: AgentConversationService
let store: AgentMastraStore
let recovery: AgentRecoveryService
const createdConversationIds: string[] = []

const config = {
  model: 'mock/mock-model',
  apiKey: 'k',
  contextTriggerRatio: 0.7,
  contextTrimTargetRatio: 0.5,
  contextCompactTargetRatio: 0.4,
  contextKeepRecentTurns: 3,
  contextToolResultMaxRatio: 0.1,
  contextFallbackWindow: 32_000,
  contextModelWindows: {},
  durableEnabled: true,
  heartbeatTimeoutMs: 1_000,
  runTimeoutMs: 60_000,
  watchdogIntervalMs: 30_000,
  multiInstance: false,
} satisfies AgentConfigValue

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

  const conversationRepo = new ConversationRepository(db)
  runs = new RunRepository(db)
  timelines = new TimelineRepository(db)
  // 本测试只关心存储与看门狗：工具用最小替身（真实工具在别的用例里覆盖）
  const registry = createAgentRegistry(
    createAgentDefinitions(createPromptEngine(), {
      describe: (keys: readonly string[]) =>
        keys.map((key) => ({ key, title: key, description: key })),
    } as never),
    DEFAULT_AGENT_KEY,
  )
  conversations = new AgentConversationService(conversationRepo, runs, timelines, registry, silentLogger)

  store = new AgentMastraStore(db, silentLogger)
  // 看门狗不碰 Redis（只有启动恢复用租约）：这里给个替身即可
  recovery = new AgentRecoveryService(null, config, runs, timelines, {} as never, silentLogger)
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
})

const newRun = async (status: string, heartbeatMsAgo = 0) => {
  const conversation = await conversations.create(USER, {})
  createdConversationIds.push(conversation.id)
  const run = await runs.create({
    conversationId: conversation.id,
    agentKey: DEFAULT_AGENT_KEY,
    status,
    engineRunId: `engine_${Math.random().toString(36).slice(2, 12)}`,
  })
  const engineRunId = `engine_${run.id}`
  await db.dataSource.query('UPDATE runs SET engine_run_id = $2 WHERE id = $1', [run.id, engineRunId])
  if (heartbeatMsAgo > 0) {
    await db.dataSource.query('UPDATE runs SET heartbeat_at = $2, started_at = $2 WHERE id = $1', [
      run.id,
      new Date(Date.now() - heartbeatMsAgo),
    ])
  }
  return { conversation, run, engineRunId }
}

describe('存储适配层（快照落我们自己的表）', () => {
  it('Mastra 门面暴露 workflows 域（只此一域：记忆不做）', async () => {
    const workflows = await store.getStore('workflows')
    expect(workflows).toBeTruthy()
  })

  it('快照往返一致；list 能按状态与 workflowName 过滤', async () => {
    const { run, engineRunId } = await newRun(RunStatus.Running)
    const snapshot = {
      runId: run.id,
      status: 'running',
      context: { input: { hello: '世界' } },
      activePaths: [0],
    } as never

    const workflows = (await store.getStore('workflows'))!
    await workflows.persistWorkflowSnapshot({
      workflowName: DEFAULT_AGENT_KEY,
      runId: engineRunId,
      snapshot,
    })

    // 往返：存进去什么，读出来就是什么（**我们不解析快照内部结构**）
    await expect(
      workflows.loadWorkflowSnapshot({ workflowName: DEFAULT_AGENT_KEY, runId: engineRunId }),
    ).resolves.toMatchObject({ context: { input: { hello: '世界' } } })

    const running = await workflows.listWorkflowRuns({ status: 'running' })
    expect(running.runs.some((item) => item.runId === engineRunId)).toBe(true)

    const byWorkflow = await workflows.listWorkflowRuns({ workflowName: DEFAULT_AGENT_KEY })
    expect(byWorkflow.runs.some((item) => item.runId === engineRunId)).toBe(true)

    const single = await workflows.getWorkflowRunById({ runId: engineRunId })
    expect(single?.workflowName).toBe(DEFAULT_AGENT_KEY)
  })

  it('运行记录不可删：delete / clear 都是 no-op（审计证据）', async () => {
    const { run, engineRunId } = await newRun(RunStatus.Running)
    const workflows = (await store.getStore('workflows'))!

    await workflows.deleteWorkflowRunById({ runId: engineRunId, workflowName: DEFAULT_AGENT_KEY })
    await workflows.dangerouslyClearAll()

    const still = await db.dataSource.query<{ id: string }[]>('SELECT id FROM runs WHERE id = $1', [
      run.id,
    ])
    expect(still).toHaveLength(1)
  })

  it('状态映射：Mastra 的 success → 我们的 succeeded', async () => {
    const { run, engineRunId } = await newRun(RunStatus.Running)
    const workflows = (await store.getStore('workflows'))!
    await workflows.persistWorkflowSnapshot({
      workflowName: DEFAULT_AGENT_KEY,
      runId: engineRunId,
      snapshot: { runId: engineRunId, status: 'success' } as never,
    })
    const rows = await db.dataSource.query<{ status: string }[]>(
      'SELECT status FROM runs WHERE id = $1',
      [run.id],
    )
    expect(rows[0].status).toBe(RunStatus.Succeeded)
  })
})

describe('看门狗（条件 UPDATE 抢执行权）', () => {
  it('心跳过期的运行被标记超时，并留下审计事件', async () => {
    const { conversation, run } = await newRun(RunStatus.Running, 5_000)

    const swept = await recovery.sweepStaleRuns()
    expect(swept).toBeGreaterThanOrEqual(1)

    const rows = await db.dataSource.query<
      { status: string; error_stage: string; error_code: string; finished_at: Date | null }[]
    >('SELECT status, error_stage, error_code, finished_at FROM runs WHERE id = $1', [run.id])
    expect(rows[0].status).toBe(RunStatus.Failed)
    expect(rows[0].error_stage).toBe('timeout')
    expect(rows[0].error_code).toBe('3310')
    expect(rows[0].finished_at).not.toBeNull()

    const audit = await timelines.list({ conversationId: conversation.id, page: 1, size: 20 })
    const event = audit.items.find((item) => item.kind === TimelineKind.Status)
    expect(event?.payload).toMatchObject({ reason: 'watchdog_timeout', operator: 'system' })
  })

  it('心跳正常的运行不动它', async () => {
    const { run } = await newRun(RunStatus.Running)
    await recovery.sweepStaleRuns()
    const rows = await db.dataSource.query<{ status: string }[]>(
      'SELECT status FROM runs WHERE id = $1',
      [run.id],
    )
    expect(rows[0].status).toBe(RunStatus.Running)
  })

  it('已经处置过的不会重复处置（条件 UPDATE 天然幂等）', async () => {
    const { run } = await newRun(RunStatus.Running, 5_000)
    await recovery.sweepStaleRuns()
    const second = await recovery.sweepStaleRuns()
    expect(second).toBe(0)
    const rows = await db.dataSource.query<{ status: string }[]>(
      'SELECT status FROM runs WHERE id = $1',
      [run.id],
    )
    expect(rows[0].status).toBe(RunStatus.Failed)
  })

  it('总时长超限（心跳还在跳）也判超时', async () => {
    const { run } = await newRun(RunStatus.Running)
    // 心跳很新，但开始时间很久以前
    await db.dataSource.query(
      "UPDATE runs SET started_at = $2, heartbeat_at = now() WHERE id = $1",
      [run.id, new Date(Date.now() - 10 * 60_000)],
    )
    await recovery.sweepStaleRuns()
    const rows = await db.dataSource.query<{ status: string }[]>(
      'SELECT status FROM runs WHERE id = $1',
      [run.id],
    )
    expect(rows[0].status).toBe(RunStatus.Failed)
  })
})
