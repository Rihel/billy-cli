import { Inject, Injectable } from '@nestjs/common'
import { AiToolEffectAttemptEntity, AiToolEffectEntity } from '@repo/db'
import type { ToolOutcome } from '@repo/contracts'
import { AppLogger, Db, affectedRowsOf } from '@repo/kits'
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
  /** 本次派发的代际（`begin` 返回的 `generation`）：旧代的迟到响应不得结算新一代 */
  generation: number
  outcome: ToolOutcome
  /** task 型调用提交成功后的任务号（非 task 调用为 null）：台账是停止时兜底取消的持久来源 */
  taskId?: string | null
}

/**
 * 结算结果：
 *
 * - `settled`：这一代的派发被正常结算（`completed` / `failed`）；
 * - `archived`：这一代已经被判成 `unknown`，只把真实结论与时间归档，**状态保持不变**
 *   （unknown 的意思就是「当时不知道」，事后补上结论不等于它当初没进过 unknown）；
 * - `stale`：代际不匹配或行不在 `dispatched`（旧代迟到响应 / 别人刚重派发）——结论不写，
 *   但**任务号照样记**（任务存在是事实，与能不能结算无关）。
 */
export type SettleResult = 'settled' | 'archived' | 'stale'

/**
 * 工具副作用台账（`docs/design/tool-effect-ledger.md`）。
 *
 * 两张表分工：
 * - `ai_tool_effects`（主表）：**当前状态**，一个 `(runId, toolCallId)` 一行，负责认领与判定；
 * - `ai_tool_effect_attempts`（每代一行）：**历史事实**，负责「第一代到底执行过没有」。
 *
 * 为什么必须分表：重派发会把主表的 `outcome` 清空（新的一代开始了），上一代的迟到归档结论
 * 就会被抹掉——而那正是出事时最需要回答的问题。历史放在按代留行的表里，重试与归档互不覆盖。
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
        const saved = await repo.save(
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
        await this.recordDispatch({
          effectId: saved.id,
          runId: input.runId,
          toolCallId: input.toolCallId,
          capability: input.capability,
          generation: 1,
          deadlineAt,
        })
        return { kind: 'proceed', attempt: 'first', generation: 1 }
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
      return { kind: 'proceed', attempt: 'first', generation: 1 }
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

    const generation = record.attempts + 1
    const affected = await this.casDispatch(record, deadlineAt)
    if (!affected) {
      return {
        kind: 'blocked',
        reason: 'effect-in-flight',
        message: '另一个执行者刚好在处理这次调用，本次不重复派发。',
      }
    }
    await this.recordDispatch({
      effectId: record.id,
      runId: record.runId,
      toolCallId: record.toolCallId,
      capability: record.capability,
      generation,
      deadlineAt,
    })
    return { kind: 'proceed', attempt: 'retry', generation }
  }

  /**
   * 结算：**必须带代际**，且只写自己那一代。
   *
   * 不带代际会有一个真实故障：A 拿 `attempts=1` 派发后超时，B 恢复时 CAS 到 `attempts=2`
   * 重新派发；A 的迟到响应回来时若只看 `status='dispatched'`，就会把 A 的结论写进 B 那一代，
   * 随后 B 的真实结论无处可写（只能记一条 settle_skipped）。带代际后两种结果都被明确拒绝。
   *
   * 主表与历史表在同一事务里更新；历史表缺行（这个功能上线前就在跑的老记录）时回退到只写主表。
   */
  async settle(input: SettleEffectInput): Promise<SettleResult> {
    let bytes = 0
    let stored: ToolOutcome | null = input.outcome
    try {
      bytes = Buffer.byteLength(JSON.stringify(input.outcome))
    } catch {
      bytes = MAX_EFFECT_RESULT_BYTES + 1
    }
    if (bytes > MAX_EFFECT_RESULT_BYTES) stored = null
    const payload = stored === null ? null : JSON.stringify(stored)
    const status: EffectStatus = input.outcome.ok ? 'completed' : 'failed'
    const taskId = input.taskId ?? null
    const args = [input.runId, input.toolCallId, input.generation] as const

    return this.db.dataSource.transaction(async (manager) => {
      const settledAttempts = affectedRowsOf<{ id: string }>(
        await manager.query(
          `
          UPDATE ai_tool_effect_attempts a
             SET status = $4,
                 outcome = $5::jsonb,
                 result_bytes = $6,
                 task_id = COALESCE($7, a.task_id),
                 settled_at = now(),
                 updated_at = now()
            FROM ai_tool_effects e
           WHERE a.effect_id = e.id AND e.run_id = $1 AND e.tool_call_id = $2
             AND a.generation = $3 AND a.status = 'dispatched' AND a.deleted_at IS NULL
          RETURNING a.id
          `,
          [...args, status, payload, bytes, taskId],
        ),
      )
      const settledEffect = affectedRowsOf<{ id: string }>(
        await manager.query(
          `
          UPDATE ai_tool_effects
             SET status = $4,
                 outcome = $5::jsonb,
                 result_bytes = $6,
                 task_id = COALESCE($7, task_id),
                 settled_at = now(),
                 updated_at = now()
           WHERE run_id = $1 AND tool_call_id = $2
             AND status = 'dispatched' AND attempts = $3 AND deleted_at IS NULL
          RETURNING id
          `,
          [...args, status, payload, bytes, taskId],
        ),
      )
      if (settledAttempts.length > 0 || settledEffect.length > 0) return 'settled'

      // 已经判过 unknown：状态不动，但把这代的真实结论与时间补进去（证据不该丢）
      const archivedAttempts = affectedRowsOf<{ id: string }>(
        await manager.query(
          `
          UPDATE ai_tool_effect_attempts a
             SET outcome = $4::jsonb,
                 result_bytes = $5,
                 task_id = COALESCE($6, a.task_id),
                 settled_at = now(),
                 updated_at = now()
            FROM ai_tool_effects e
           WHERE a.effect_id = e.id AND e.run_id = $1 AND e.tool_call_id = $2
             AND a.generation = $3 AND a.status = 'unknown' AND a.settled_at IS NULL
             AND a.deleted_at IS NULL
          RETURNING a.id
          `,
          [...args, payload, bytes, taskId],
        ),
      )
      const archivedEffect = affectedRowsOf<{ id: string }>(
        await manager.query(
          `
          UPDATE ai_tool_effects
             SET outcome = $4::jsonb,
                 result_bytes = $5,
                 task_id = COALESCE($6, task_id),
                 settled_at = now(),
                 updated_at = now()
           WHERE run_id = $1 AND tool_call_id = $2
             AND status = 'unknown' AND attempts = $3 AND settled_at IS NULL AND deleted_at IS NULL
          RETURNING id
          `,
          [...args, payload, bytes, taskId],
        ),
      )
      if (archivedAttempts.length > 0 || archivedEffect.length > 0) return 'archived'

      // 旧代迟到响应：结论不写（那是新一代的事），但任务号必须留下 ——
      // 任务是否真实存在与「能不能结算这一代」是两件事，停止对话时靠它兜底取消。
      if (taskId !== null) await this.recordTaskId(manager, args, taskId)
      return 'stale'
    })
  }

  /**
   * 把「派发后超期、又没人结算」的行判成 `unknown`。
   *
   * 懒转换（等下一次 `begin` 再判）只在同一调用被重放时发生；崩溃后没人再碰它的那些行
   * 会永久停在 `dispatched`。这个方法补上定时转换，语义才算和文档一致。
   * 条件用库里的 `now()`，与写入 `deadline_at` 的时钟同源。
   *
   * 注意它**只改状态、不重试**：超期只说明「等不到结算」，不代表外部执行已经结束。
   */
  async sweepExpired(limit = 200): Promise<number> {
    return this.db.dataSource.transaction(async (manager) => {
      // 以**主表**为准选出超期行，再把它们的历史行一起转 unknown —— 两张表的状态必须一致，
      // 否则「主表 unknown 但历史仍 dispatched」会让旧代迟到响应把历史行结算掉。
      const expired = affectedRowsOf<{ id: string }>(
        await manager.query(
          `
        UPDATE ai_tool_effects
           SET status = 'unknown', updated_at = now()
         WHERE id IN (
           SELECT id FROM ai_tool_effects
            WHERE status = 'dispatched' AND deadline_at < now() AND deleted_at IS NULL
            ORDER BY deadline_at
            LIMIT $1
         )
        RETURNING id
        `,
          [limit],
        ),
      )
      if (expired.length === 0) return 0
      await manager.query(
        `
        UPDATE ai_tool_effect_attempts
           SET status = 'unknown', updated_at = now()
         WHERE effect_id = ANY($1::text[]) AND status = 'dispatched' AND deleted_at IS NULL
        `,
        [expired.map((row) => row.id)],
      )
      return expired.length
    })
  }

  /**
   * 这一轮发起过的任务号（停止对话时兜底取消用）。
   *
   * `ai:capability:run-tasks:<runId>` 那条 Redis 映射是 best-effort：写失败只 warn、进程死
   * 在「提交成功」与「映射落库」之间还会整条丢。历史表是持久事实，停止时两边取并集，
   * 才不会让任务变成没人管的孤儿。
   *
   * 窗口按 **`updated_at`**（任务号写入时间）算，不是按记录创建时间 —— 记录建得早、
   * 任务提交得晚的情况（>窗口）不能因此被漏掉。
   */
  async taskIdsForRun(runId: string, withinMs = 6 * 60 * 60 * 1000): Promise<string[]> {
    const rows = await this.db.dataSource.query<Array<{ task_id: string }>>(
      `
      SELECT DISTINCT task_id FROM (
        SELECT task_id FROM ai_tool_effect_attempts
         WHERE run_id = $1 AND task_id IS NOT NULL AND deleted_at IS NULL
           AND updated_at > now() - ($2::text || ' milliseconds')::interval
        UNION
        SELECT task_id FROM ai_tool_effects
         WHERE run_id = $1 AND task_id IS NOT NULL AND deleted_at IS NULL
           AND updated_at > now() - ($2::text || ' milliseconds')::interval
      ) AS merged
      `,
      [runId, withinMs],
    )
    return rows.map((row) => row.task_id)
  }

  private async find(runId: string, toolCallId: string): Promise<EffectRecord | null> {
    const repo = this.db.getRepository(AiToolEffectEntity)
    const row = await repo.findOne({ where: { runId, toolCallId } })
    if (!row) return null
    return {
      id: row.id,
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

  /** 历史表：记一行「第 N 代开始了」 */
  private async recordDispatch(input: {
    effectId: string
    runId: string
    toolCallId: string
    capability: string
    generation: number
    deadlineAt: Date
  }): Promise<void> {
    const repo = this.db.getRepository(AiToolEffectAttemptEntity)
    try {
      await repo.save(
        repo.create({
          effectId: input.effectId,
          runId: input.runId,
          toolCallId: input.toolCallId,
          capability: input.capability,
          generation: input.generation,
          status: 'dispatched',
          deadlineAt: input.deadlineAt,
          outcome: null,
          resultBytes: 0,
          taskId: null,
          settledAt: null,
        }),
      )
    } catch (error) {
      // 历史行写不进去不该让「已经拿到派发权」的调用失败，但必须留痕（丢的是证据，不是执行）
      this.logger.error('tool_gateway.effect_attempt_record_failed', {
        effectId: input.effectId,
        generation: input.generation,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async recordTaskId(
    manager: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    args: readonly [string, string, number],
    taskId: string,
  ): Promise<void> {
    await manager.query(
      `
      UPDATE ai_tool_effect_attempts a
         SET task_id = COALESCE(a.task_id, $4), updated_at = now()
        FROM ai_tool_effects e
       WHERE a.effect_id = e.id AND e.run_id = $1 AND e.tool_call_id = $2
         AND a.generation = $3 AND a.deleted_at IS NULL
      `,
      [...args, taskId],
    )
    await manager.query(
      `
      UPDATE ai_tool_effects
         SET task_id = COALESCE(task_id, $3), updated_at = now()
       WHERE run_id = $1 AND tool_call_id = $2 AND deleted_at IS NULL
      `,
      [args[0], args[1], taskId],
    )
  }

  /**
   * 抢重试派发权：条件写回，抢不到返回 0（别的执行者已经接手）。
   *
   * 抢到之后把**上一代**仍挂在 `dispatched` 的历史行收尾成 `unknown`：既然我们重新派发了，
   * 就不再等它；它之后迟到的响应会走「归档」而不是「结算」，既不丢证据也不会污染新一代。
   */
  private async casDispatch(record: EffectRecord, deadlineAt: Date): Promise<number> {
    return this.db.dataSource.transaction(async (manager) => {
      const rows = affectedRowsOf<{ id: string }>(
        await manager.query(
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
        ),
      )
      if (rows.length === 0) return 0
      await manager.query(
        `
        UPDATE ai_tool_effect_attempts
           SET status = 'unknown', updated_at = now()
         WHERE effect_id = $1 AND generation = $2 AND status = 'dispatched' AND deleted_at IS NULL
        `,
        [record.id, record.attempts],
      )
      return rows.length
    })
  }

  private async markUnknown(record: EffectRecord): Promise<void> {
    await this.db.dataSource
      .transaction(async (manager) => {
        await manager.query(
          `
        UPDATE ai_tool_effect_attempts
           SET status = 'unknown', updated_at = now()
         WHERE effect_id = $1 AND generation = $2 AND status = 'dispatched' AND deleted_at IS NULL
        `,
          [record.id, record.attempts],
        )
        await manager.query(
          `
        UPDATE ai_tool_effects
           SET status = 'unknown', updated_at = now()
         WHERE run_id = $1 AND tool_call_id = $2 AND status = 'dispatched' AND attempts = $3
           AND deleted_at IS NULL
        `,
          [record.runId, record.toolCallId, record.attempts],
        )
      })
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
