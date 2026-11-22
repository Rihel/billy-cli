import { Inject, Injectable } from '@nestjs/common'
import { AiToolEffectEntity } from '@repo/db'
import type { ToolOutcome } from '@repo/contracts'
import { AppLogger, Db } from '@repo/kits'
import {
  MAX_EFFECT_RESULT_BYTES,
  decideEffect,
  type EffectDecision,
  type EffectPolicy,
  type EffectRecord,
  type EffectStatus,
} from './tool-effect.types.js'

/** 派发偏保守：调用方给的 deadline 之外再留一点传输余量，避免「刚好卡在边界」被判 unknown */
const SETTLE_GRACE_MS = 5_000

export interface BeginEffectInput {
  runId: string
  conversationId: string
  toolCallId: string
  capability: string
  requestHash: string
  /** 本次调用的执行预算（协议里的 deadlineMs） */
  timeoutMs: number
  policy: EffectPolicy
}

export interface SettleEffectInput {
  runId: string
  toolCallId: string
  outcome: ToolOutcome
}

/**
 * 工具副作用台账（`docs/design/tool-effect-ledger.md`）。
 *
 * 只干两件事：**派发前认领**（`begin`）与**结算**（`settle`）。判定逻辑在
 * `tool-effect.types.ts` 的纯函数里，这里只负责原子性与落库。
 *
 * 三条纪律：
 * - 认领用唯一索引 `(run_id, tool_call_id)`，并发重放只有一个执行者；
 * - 重试必须先 CAS 抢派发权（`status + attempts` 作条件），抢不到就如实报 in-flight；
 * - 台账写不进去时**不静默放行**：调用方按能力风险决定（不可逆动作直接拒绝）。
 */
@Injectable()
export class ToolEffectLedger {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async begin(input: BeginEffectInput): Promise<EffectDecision> {
    const repo = this.db.getRepository(AiToolEffectEntity)
    const now = Date.now()
    const deadlineAt = new Date(now + input.timeoutMs + SETTLE_GRACE_MS)

    const existing = await this.find(input.runId, input.toolCallId)
    if (!existing) {
      try {
        await repo.save(
          repo.create({
            runId: input.runId,
            conversationId: input.conversationId,
            toolCallId: input.toolCallId,
            capability: input.capability,
            requestHash: input.requestHash,
            status: 'dispatched',
            attempts: 1,
            deadlineAt,
            outcome: null,
            resultBytes: 0,
            settledAt: null,
          }),
        )
        return { kind: 'proceed', attempt: 'first' }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        // 并发：另一个执行者刚好抢先插入，落到下面的「按已有记录判定」
      }
    }

    const record = existing ?? (await this.find(input.runId, input.toolCallId))
    if (!record) {
      this.logger.warn('tool_gateway.effect_record_vanished', {
        runId: input.runId,
        toolCallId: input.toolCallId,
        capability: input.capability,
      })
      return { kind: 'proceed', attempt: 'first' }
    }

    const decision = decideEffect(record, now, input.policy, input.requestHash)
    if (decision.kind !== 'proceed') {
      if (
        decision.kind === 'blocked' &&
        decision.reason === 'effect-unknown' &&
        record.status === 'dispatched'
      ) {
        await this.markUnknown(record)
      }
      return decision
    }

    const affected = await this.casDispatch(record, deadlineAt)
    if (affected) return decision
    return {
      kind: 'blocked',
      reason: 'effect-in-flight',
      message: '另一个执行者刚好在处理这次调用，本次不重复派发。',
    }
  }

  /** 结算：只有「还是 dispatched」的那一行能被写成结论（超时判 unknown 之后不会被覆盖） */
  async settle(input: SettleEffectInput): Promise<boolean> {
    let bytes = 0
    let stored: ToolOutcome | null = input.outcome
    try {
      bytes = Buffer.byteLength(JSON.stringify(input.outcome))
    } catch {
      bytes = MAX_EFFECT_RESULT_BYTES + 1
    }
    if (bytes > MAX_EFFECT_RESULT_BYTES) stored = null
    const status: EffectStatus = input.outcome.ok ? 'completed' : 'failed'
    const rows = await this.db.dataSource.query<Array<{ id: string }>>(
      `
      UPDATE ai_tool_effects
         SET status = $3,
             outcome = $4::jsonb,
             result_bytes = $5,
             settled_at = now(),
             updated_at = now()
       WHERE run_id = $1 AND tool_call_id = $2 AND status = 'dispatched' AND deleted_at IS NULL
      RETURNING id
      `,
      [
        input.runId,
        input.toolCallId,
        status,
        stored === null ? null : JSON.stringify(stored),
        bytes,
      ],
    )
    return rows.length > 0
  }

  private async find(runId: string, toolCallId: string): Promise<EffectRecord | null> {
    const repo = this.db.getRepository(AiToolEffectEntity)
    const row = await repo.findOne({ where: { runId, toolCallId } })
    if (!row) return null
    return {
      runId: row.runId,
      toolCallId: row.toolCallId,
      capability: row.capability,
      requestHash: row.requestHash,
      status: row.status as EffectStatus,
      attempts: row.attempts,
      deadlineAt: row.deadlineAt,
      outcome: (row.outcome as ToolOutcome | null) ?? null,
      resultBytes: row.resultBytes,
    }
  }

  /** 抢重试派发权：条件写回，抢不到返回 0（别的执行者已经接手） */
  private async casDispatch(record: EffectRecord, deadlineAt: Date): Promise<number> {
    const rows = await this.db.dataSource.query<Array<{ id: string }>>(
      `
      UPDATE ai_tool_effects
         SET status = 'dispatched',
             attempts = attempts + 1,
             deadline_at = $4,
             outcome = NULL,
             result_bytes = 0,
             settled_at = NULL,
             updated_at = now()
       WHERE run_id = $1 AND tool_call_id = $2 AND status = $3 AND attempts = $5 AND deleted_at IS NULL
      RETURNING id
      `,
      [record.runId, record.toolCallId, record.status, deadlineAt, record.attempts],
    )
    return rows.length
  }

  private async markUnknown(record: EffectRecord): Promise<void> {
    await this.db.dataSource
      .query(
        `
      UPDATE ai_tool_effects
         SET status = 'unknown', updated_at = now()
       WHERE run_id = $1 AND tool_call_id = $2 AND status = 'dispatched' AND attempts = $3
         AND deleted_at IS NULL
      `,
        [record.runId, record.toolCallId, record.attempts],
      )
      .catch((error: unknown) => {
        this.logger.warn('tool_gateway.effect_mark_unknown_failed', {
          runId: record.runId,
          toolCallId: record.toolCallId,
          reason: error instanceof Error ? error.message : String(error),
        })
      })
  }
}

/** PG 唯一约束冲突（node-postgres 的 error.code） */
const isUniqueViolation = (error: unknown): boolean => {
  const value = error as { code?: string; driverError?: { code?: string } } | null
  return value?.code === '23505' || value?.driverError?.code === '23505'
}
