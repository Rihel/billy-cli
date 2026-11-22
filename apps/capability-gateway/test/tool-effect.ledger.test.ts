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
    expect(await begin(runId)).toEqual({ kind: 'proceed', attempt: 'first' })

    // 未结算时同一调用不重复派发
    const inFlight = await begin(runId)
    expect(inFlight.kind).toBe('blocked')
    if (inFlight.kind === 'blocked') expect(inFlight.reason).toBe('effect-in-flight')

    expect(await ledger.settle({ runId, toolCallId: 'call-1', outcome: okOutcome })).toBe(true)
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

  it('幂等写派发后超时 → 允许重试，attempts 递增', async () => {
    const runId = newRun()
    await begin(runId, { timeoutMs: 1, idempotent: true })
    await db.dataSource.query(
      `UPDATE ai_tool_effects SET deadline_at = now() - interval '1 second' WHERE run_id = $1`,
      [runId],
    )

    expect(await begin(runId, { idempotent: true })).toEqual({
      kind: 'proceed',
      attempt: 'retry',
    })
    const rows = await db.dataSource.query<Array<{ status: string; attempts: number }>>(
      'SELECT status, attempts FROM ai_tool_effects WHERE run_id = $1',
      [runId],
    )
    expect(rows[0]?.status).toBe('dispatched')
    expect(Number(rows[0]?.attempts)).toBe(2)
  })

  it('结论超过留存上限：不可逆动作报结果不可用，不重跑', async () => {
    const runId = newRun()
    await begin(runId)
    const huge: ToolOutcome = {
      ok: true,
      data: { text: 'x'.repeat(MAX_EFFECT_RESULT_BYTES + 100) },
    }
    expect(await ledger.settle({ runId, toolCallId: 'call-1', outcome: huge })).toBe(true)

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
