import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DB_ENTITIES } from '@repo/db'
import { Db } from '@repo/kits'
import type { ToolOutcome } from '@repo/contracts'
import { canonicalHash } from '../src/effects/canonical-hash.js'
import { ToolEffectLedger } from '../src/effects/tool-effect.ledger.js'
import { MAX_EFFECT_RESULT_BYTES } from '../src/effects/tool-effect.types.js'

const silentLogger = {
  info: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

let db: Db
let ledger: ToolEffectLedger
const runIds: string[] = []

beforeAll(async () => {
  db = new Db(
    { url: process.env.DB_URL!, sync: false, entities: [...DB_ENTITIES] } as never,
    silentLogger,
  )
  await db.onApplicationBootstrap()
  if (!db.dataSource.isInitialized) throw new Error('数据库初始化失败')
  ledger = new ToolEffectLedger(db, silentLogger)
})

afterAll(async () => {
  if (runIds.length > 0) {
    await db.dataSource.query('DELETE FROM ai_tool_effects WHERE run_id = ANY($1)', [runIds])
  }
  await db.close()
})

const newRun = (): string => {
  const runId = `te-${randomUUID().slice(0, 16)}`
  runIds.push(runId)
  return runId
}

const begin = (
  runId: string,
  over: {
    toolCallId?: string
    input?: unknown
    timeoutMs?: number
    idempotent?: boolean
    risk?: 'read' | 'write'
  } = {},
) =>
  ledger.begin({
    runId,
    conversationId: 'conv-1',
    toolCallId: over.toolCallId ?? 'call-1',
    capability: 'bash',
    requestHash: canonicalHash({ capability: 'bash', input: over.input ?? { command: 'echo hi' } }),
    timeoutMs: over.timeoutMs ?? 30_000,
    policy: { risk: over.risk ?? 'write', idempotent: over.idempotent ?? false },
  })

const okOutcome: ToolOutcome = { ok: true, data: { output: 'hi' } }

describe('ToolEffectLedger（副作用台账）', () => {
  it('首次认领 → 结算 → 重放复用结论，不再执行', async () => {
    const runId = newRun()
    expect(await begin(runId)).toEqual({ kind: 'proceed', attempt: 'first', generation: 1 })

    // 未结算时同一调用不重复派发
    const inFlight = await begin(runId)
    expect(inFlight.kind).toBe('blocked')
    if (inFlight.kind === 'blocked') expect(inFlight.reason).toBe('effect-in-flight')

    expect(
      await ledger.settle({ runId, toolCallId: 'call-1', generation: 1, outcome: okOutcome }),
    ).toBe('settled')
    expect(await begin(runId)).toEqual({ kind: 'replay', outcome: okOutcome })
  })

  it('同一句柄换了参数 → 冲突，不当作重放', async () => {
    const runId = newRun()
    await begin(runId)
    const decision = await begin(runId, { input: { command: 'rm -rf /' } })
    expect(decision.kind).toBe('blocked')
    if (decision.kind === 'blocked') expect(decision.reason).toBe('effect-conflict')
  })

  it('不可逆动作派发后超时 → unknown，且台账状态落成 unknown', async () => {
    const runId = newRun()
    // timeoutMs=0 → 派发即过期（含 5s 余量后仍然立刻过期不成立，改用手改 deadline）
    await begin(runId, { timeoutMs: 1 })
    await db.dataSource.query(
      `UPDATE ai_tool_effects SET deadline_at = now() - interval '1 second' WHERE run_id = $1`,
      [runId],
    )

    const decision = await begin(runId)
    expect(decision.kind).toBe('blocked')
    if (decision.kind === 'blocked') expect(decision.reason).toBe('effect-unknown')

    const rows = await db.dataSource.query<Array<{ status: string }>>(
      'SELECT status FROM ai_tool_effects WHERE run_id = $1',
      [runId],
    )
    expect(rows[0]?.status).toBe('unknown')
  })

  it('只读派发后超时 → 允许重试，attempts 递增', async () => {
    const runId = newRun()
    await begin(runId, { timeoutMs: 1, risk: 'read' })
    await db.dataSource.query(
      `UPDATE ai_tool_effects SET deadline_at = now() - interval '1 second' WHERE run_id = $1`,
      [runId],
    )

    expect(await begin(runId, { risk: 'read' })).toEqual({
      kind: 'proceed',
      attempt: 'retry',
      generation: 2,
    })
    const rows = await db.dataSource.query<Array<{ status: string; attempts: number }>>(
      'SELECT status, attempts FROM ai_tool_effects WHERE run_id = $1',
      [runId],
    )
    expect(rows[0]?.status).toBe('dispatched')
    expect(Number(rows[0]?.attempts)).toBe(2)
  })

  it('幂等写派发后超期 → 不自动重试（超时不等于执行结束）', async () => {
    const runId = newRun()
    await begin(runId, { timeoutMs: 1, idempotent: true })
    await db.dataSource.query(
      `UPDATE ai_tool_effects SET deadline_at = now() - interval '1 second' WHERE run_id = $1`,
      [runId],
    )

    const decision = await begin(runId, { idempotent: true })
    expect(decision.kind).toBe('blocked')
    if (decision.kind === 'blocked') expect(decision.reason).toBe('effect-unknown')

    const rows = await db.dataSource.query<Array<{ status: string; attempts: number }>>(
      'SELECT status, attempts FROM ai_tool_effects WHERE run_id = $1',
      [runId],
    )
    expect(rows[0]?.status).toBe('unknown')
    expect(Number(rows[0]?.attempts)).toBe(1)
  })

  it('结论超过留存上限：不可逆动作报结果不可用，不重跑', async () => {
    const runId = newRun()
    await begin(runId)
    const huge: ToolOutcome = {
      ok: true,
      data: { text: 'x'.repeat(MAX_EFFECT_RESULT_BYTES + 100) },
    }
    expect(await ledger.settle({ runId, toolCallId: 'call-1', generation: 1, outcome: huge })).toBe(
      'settled',
    )

    const decision = await begin(runId)
    expect(decision.kind).toBe('blocked')
    if (decision.kind === 'blocked') expect(decision.reason).toBe('effect-result-unavailable')

    const rows = await db.dataSource.query<Array<{ result_bytes: number; outcome: unknown }>>(
      'SELECT result_bytes, outcome FROM ai_tool_effects WHERE run_id = $1',
      [runId],
    )
    expect(rows[0]?.outcome).toBeNull()
    expect(Number(rows[0]?.result_bytes)).toBeGreaterThan(MAX_EFFECT_RESULT_BYTES)
  })

  it('并发认领同一调用只放行一个执行者', async () => {
    const runId = newRun()
    const results = await Promise.all(Array.from({ length: 5 }, () => begin(runId)))
    expect(results.filter((result) => result.kind === 'proceed')).toHaveLength(1)
    expect(results.filter((result) => result.kind === 'blocked')).toHaveLength(4)
  })
})

/**
 * 结算代际（2026-11-22 复审的 P0）与超期兜底：
 * 旧代的迟到响应不能结算新一代的记录，否则新一代的真实结论会丢。
 */
describe('ToolEffectLedger：结算代际与超期兜底', () => {
  it('旧代的迟到响应不能结算新一代（返回 stale，记录保持 dispatched）', async () => {
    const runId = newRun()
    const first = await begin(runId, { timeoutMs: 1, risk: 'read' })
    expect(first).toEqual({ kind: 'proceed', attempt: 'first', generation: 1 })

    // 模拟第一次派发超期后，另一个执行者重新派发（只读能力才允许在未知态重跑）
    await db.dataSource.query(
      `UPDATE ai_tool_effects SET deadline_at = now() - interval '1 second' WHERE run_id = $1`,
      [runId],
    )
    const retry = await begin(runId, { risk: 'read' })
    expect(retry).toEqual({ kind: 'proceed', attempt: 'retry', generation: 2 })

    // 旧代（generation 1）的响应回来：只能归档进**旧代自己的历史行**，不能结算主表
    expect(
      await ledger.settle({ runId, toolCallId: 'call-1', generation: 1, outcome: okOutcome }),
    ).toBe('archived')

    // 新一代（generation 2）的响应可以正常结算
    const other: ToolOutcome = { ok: true, data: { output: 'retry-result' } }
    expect(
      await ledger.settle({ runId, toolCallId: 'call-1', generation: 2, outcome: other }),
    ).toBe('settled')

    const rows = await db.dataSource.query<Array<{ status: string; outcome: unknown }>>(
      'SELECT status, outcome FROM ai_tool_effects WHERE run_id = $1',
      [runId],
    )
    expect(rows[0]?.status).toBe('completed')
    expect(rows[0]?.outcome).toMatchObject({ data: { output: 'retry-result' } })

    // 两代历史都在：第一代 unknown 但留了归档结论，第二代 completed
    const attempts = await db.dataSource.query<
      Array<{ generation: number; status: string; outcome: unknown }>
    >(
      `SELECT generation, status, outcome FROM ai_tool_effect_attempts WHERE run_id = $1
        ORDER BY generation`,
      [runId],
    )
    expect(attempts.map((row) => row.generation)).toEqual([1, 2])
    expect(attempts[0]).toMatchObject({ status: 'unknown', outcome: { data: { output: 'hi' } } })
    expect(attempts[1]).toMatchObject({ status: 'completed' })
  })

  it('超期 dispatched 由扫描器转 unknown（不再依赖下一次 begin）', async () => {
    const runId = newRun()
    await begin(runId, { timeoutMs: 1 })
    await db.dataSource.query(
      `UPDATE ai_tool_effects SET deadline_at = now() - interval '1 second' WHERE run_id = $1`,
      [runId],
    )

    expect(await ledger.sweepExpired()).toBeGreaterThanOrEqual(1)
    const rows = await db.dataSource.query<Array<{ status: string }>>(
      'SELECT status FROM ai_tool_effects WHERE run_id = $1',
      [runId],
    )
    expect(rows[0]?.status).toBe('unknown')

    // 再扫一次：已经是 unknown 的行不会被重复处理
    const again = await ledger.sweepExpired()
    expect(again).toBe(0)
  })

  it('unknown 之后的迟到结论归档：状态不变，结论与时间补进台账', async () => {
    const runId = newRun()
    await begin(runId, { timeoutMs: 1 })
    await db.dataSource.query(
      `UPDATE ai_tool_effects SET deadline_at = now() - interval '1 second' WHERE run_id = $1`,
      [runId],
    )
    await ledger.sweepExpired()

    const late: ToolOutcome = { ok: true, data: { output: 'late-but-real' } }
    expect(await ledger.settle({ runId, toolCallId: 'call-1', generation: 1, outcome: late })).toBe(
      'archived',
    )

    const rows = await db.dataSource.query<
      Array<{ status: string; outcome: unknown; settled_at: Date | null }>
    >('SELECT status, outcome, settled_at FROM ai_tool_effects WHERE run_id = $1', [runId])
    expect(rows[0]?.status).toBe('unknown')
    expect(rows[0]?.outcome).toMatchObject({ data: { output: 'late-but-real' } })
    expect(rows[0]?.settled_at).not.toBeNull()

    // 第二个迟到响应不再覆盖已归档的结论
    expect(
      await ledger.settle({
        runId,
        toolCallId: 'call-1',
        generation: 1,
        outcome: { ok: false, reason: 'timeout', message: '迟到的失败' },
      }),
    ).toBe('stale')
  })
})

describe('ToolEffectLedger：重试认领的并发', () => {
  it('两个执行者同时抢同一次重试派发：只有一个拿到 proceed', async () => {
    const runId = newRun()
    await begin(runId, { timeoutMs: 1, risk: 'read' })
    await db.dataSource.query(
      `UPDATE ai_tool_effects SET deadline_at = now() - interval '1 second' WHERE run_id = $1`,
      [runId],
    )

    const results = await Promise.all([
      begin(runId, { risk: 'read' }),
      begin(runId, { risk: 'read' }),
    ])
    expect(results.filter((result) => result.kind === 'proceed')).toHaveLength(1)
    expect(results.filter((result) => result.kind === 'blocked')).toHaveLength(1)
    // 抢输的一方必须是 in-flight（另一个执行者已经接手），不能是 unknown / 冲突
    const blocked = results.find((result) => result.kind === 'blocked')
    if (blocked?.kind === 'blocked') expect(blocked.reason).toBe('effect-in-flight')

    const rows = await db.dataSource.query<Array<{ attempts: number }>>(
      'SELECT attempts FROM ai_tool_effects WHERE run_id = $1',
      [runId],
    )
    expect(Number(rows[0]?.attempts)).toBe(2)
  })
})

/**
 * task 型调用的任务号要能按 run 反查（停止对话时兜底取消）。
 * 背景：`ai:capability:run-tasks:<runId>` 是 best-effort 的 Redis 映射，丢了就取消不到任务。
 */
describe('ToolEffectLedger：task 型调用的任务号', () => {
  it('结算时落 task_id，按 run 能查回来；非 task 调用不混进来', async () => {
    const runId = newRun()
    await begin(runId, { timeoutMs: 30_000 })
    await ledger.settle({
      runId,
      toolCallId: 'call-1',
      generation: 1,
      taskId: 'task-abc',
      outcome: { ok: true, data: { task: { id: 'task-abc' } } },
    })

    await begin(runId, { toolCallId: 'call-2' })
    await ledger.settle({
      runId,
      toolCallId: 'call-2',
      generation: 1,
      outcome: okOutcome,
    })

    expect(await ledger.taskIdsForRun(runId)).toEqual(['task-abc'])
  })

  it('unknown 后归档的迟到结论同样会补上 task_id', async () => {
    const runId = newRun()
    await begin(runId, { timeoutMs: 1 })
    await db.dataSource.query(
      `UPDATE ai_tool_effects SET deadline_at = now() - interval '1 second' WHERE run_id = $1`,
      [runId],
    )
    await ledger.sweepExpired()

    expect(
      await ledger.settle({
        runId,
        toolCallId: 'call-1',
        generation: 1,
        taskId: 'task-late',
        outcome: { ok: true, data: { task: { id: 'task-late' } } },
      }),
    ).toBe('archived')
    expect(await ledger.taskIdsForRun(runId)).toEqual(['task-late'])
  })

  it('窗口外的旧任务不返回（默认 6 小时，避免把历史轮次的任务一起取消）', async () => {
    const runId = newRun()
    await begin(runId, { timeoutMs: 30_000 })
    await ledger.settle({
      runId,
      toolCallId: 'call-1',
      generation: 1,
      taskId: 'task-old',
      outcome: { ok: true, data: { task: { id: 'task-old' } } },
    })
    await db.dataSource.query(
      `UPDATE ai_tool_effects SET created_at = now() - interval '7 hours',
                                  updated_at = now() - interval '7 hours'
        WHERE run_id = $1`,
      [runId],
    )
    await db.dataSource.query(
      `UPDATE ai_tool_effect_attempts SET updated_at = now() - interval '7 hours'
        WHERE run_id = $1`,
      [runId],
    )
    expect(await ledger.taskIdsForRun(runId)).toEqual([])
  })
})

/**
 * 历史表的意义：重派发不能抹掉上一代已经归档的结论（复审的「硬伤二」）。
 * 主表只保留当前态，历史按代留行 —— 否则台账在最需要用来说明事故时会选择性失忆。
 */
describe('ToolEffectLedger：每代历史互不覆盖', () => {
  it('归档之后又被重派发：上一代的归档结论仍在历史表里', async () => {
    const runId = newRun()
    await begin(runId, { timeoutMs: 1, risk: 'read' })
    await db.dataSource.query(
      `UPDATE ai_tool_effects SET deadline_at = now() - interval '1 second' WHERE run_id = $1`,
      [runId],
    )
    await ledger.sweepExpired()

    const late: ToolOutcome = { ok: true, data: { output: 'first-generation-really-done' } }
    expect(await ledger.settle({ runId, toolCallId: 'call-1', generation: 1, outcome: late })).toBe(
      'archived',
    )

    // 归档之后允许只读能力重跑：主表被清空，但历史行不能被清
    expect(await begin(runId, { risk: 'read' })).toEqual({
      kind: 'proceed',
      attempt: 'retry',
      generation: 2,
    })

    const attempts = await db.dataSource.query<
      Array<{ generation: number; status: string; outcome: unknown }>
    >(
      `SELECT generation, status, outcome FROM ai_tool_effect_attempts WHERE run_id = $1
        ORDER BY generation`,
      [runId],
    )
    expect(attempts[0]).toMatchObject({
      generation: 1,
      status: 'unknown',
      outcome: { data: { output: 'first-generation-really-done' } },
    })
    expect(attempts[1]).toMatchObject({ generation: 2, status: 'dispatched' })

    const effect = await db.dataSource.query<Array<{ status: string; outcome: unknown }>>(
      'SELECT status, outcome FROM ai_tool_effects WHERE run_id = $1',
      [runId],
    )
    // 主表是新的一代：结论被清空（这是对的，当前态不该挂着上一代的结果）
    expect(effect[0]).toMatchObject({ status: 'dispatched', outcome: null })
  })

  it('旧代迟到响应被判归档时，任务号照样记下来（停止时才能兜底取消）', async () => {
    const runId = newRun()
    await begin(runId, { timeoutMs: 1, risk: 'read' })
    await db.dataSource.query(
      `UPDATE ai_tool_effects SET deadline_at = now() - interval '1 second' WHERE run_id = $1`,
      [runId],
    )
    expect(await begin(runId, { risk: 'read' })).toMatchObject({ generation: 2 })

    // 第一代其实提交过任务：被判归档（不是结算），但 task_id 必须留下
    expect(
      await ledger.settle({
        runId,
        toolCallId: 'call-1',
        generation: 1,
        taskId: 'task-from-gen-1',
        outcome: { ok: true, data: { task: { id: 'task-from-gen-1' } } },
      }),
    ).toBe('archived')
    expect(await ledger.taskIdsForRun(runId)).toContain('task-from-gen-1')
  })

  it('扫描器把主表转 unknown 时，同一代的历史行一起转（两表状态一致）', async () => {
    const runId = newRun()
    await begin(runId, { timeoutMs: 1 })
    await db.dataSource.query(
      `UPDATE ai_tool_effects SET deadline_at = now() - interval '1 second' WHERE run_id = $1`,
      [runId],
    )
    await ledger.sweepExpired()

    const effect = await db.dataSource.query<Array<{ status: string }>>(
      'SELECT status FROM ai_tool_effects WHERE run_id = $1',
      [runId],
    )
    const attempts = await db.dataSource.query<Array<{ status: string }>>(
      'SELECT status FROM ai_tool_effect_attempts WHERE run_id = $1',
      [runId],
    )
    expect(effect[0]?.status).toBe('unknown')
    expect(attempts[0]?.status).toBe('unknown')
  })
})
