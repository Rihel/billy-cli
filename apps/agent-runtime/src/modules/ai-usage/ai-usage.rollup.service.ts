import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, Db } from '@repo/kits'
import { nanoid } from '@repo/shared'
import { AiUsageDailyEntity } from '../../database/entities/ai-usage-daily-entity.js'
import { AiUsageDailyDimensionEntity } from '../../database/entities/ai-usage-daily-dimension-entity.js'

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

/** 上海业务日 → YYYY-MM-DD */
export const shanghaiDateKey = (date: Date): string => {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS)
  return shifted.toISOString().slice(0, 10)
}

/** 今天 / 昨天（上海） */
export const recentShanghaiDates = (now = new Date()): [string, string] => {
  const today = shanghaiDateKey(now)
  const yesterday = shanghaiDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000))
  return [today, yesterday]
}

const addDays = (date: string, days: number): string => {
  const base = new Date(`${date}T00:00:00.000Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

const nums = (value: unknown): number => Number(value ?? 0)

/** AI 用量日表汇总：从 runs / timelines 重算某一天，先删后插，幂等可回填 */
@Injectable()
export class AiUsageRollupService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 重算某一天（上海业务日） */
  async rollupDay(statDate: string): Promise<void> {
    await this.db.dataSource.transaction(async (manager) => {
      await manager.delete(AiUsageDailyEntity, { statDate })
      await manager.delete(AiUsageDailyDimensionEntity, { statDate })

      const [dailyRow] = await manager.query<DailyRow[]>(DAILY_SQL, [statDate])
      const daily = manager.getRepository(AiUsageDailyEntity).create({
        id: nanoid(),
        statDate,
        conversations: nums(dailyRow?.conversations),
        newConversations: nums(dailyRow?.newConversations),
        activeUsers: nums(dailyRow?.activeUsers),
        runs: nums(dailyRow?.runs),
        succeeded: nums(dailyRow?.succeeded),
        failed: nums(dailyRow?.failed),
        canceled: nums(dailyRow?.canceled),
        interrupted: nums(dailyRow?.interrupted),
        totalTokens: nums(dailyRow?.totalTokens),
        inputTokens: nums(dailyRow?.inputTokens),
        outputTokens: nums(dailyRow?.outputTokens),
        cacheReadTokens: nums(dailyRow?.cacheReadTokens),
        cacheWriteTokens: nums(dailyRow?.cacheWriteTokens),
        reasoningTokens: nums(dailyRow?.reasoningTokens),
        steps: nums(dailyRow?.steps),
        toolCalls: nums(dailyRow?.toolCalls),
        toolSucceeded: nums(dailyRow?.toolSucceeded),
        toolFailed: nums(dailyRow?.toolFailed),
        toolDenied: nums(dailyRow?.toolDenied),
        toolInvalid: nums(dailyRow?.toolInvalid),
        toolUnknown: nums(dailyRow?.toolUnknown),
        toolNoResult: nums(dailyRow?.toolNoResult),
        runDurationMs: nums(dailyRow?.runDurationMs),
        firstTokenMsSum: nums(dailyRow?.firstTokenMsSum),
        firstTokenRuns: nums(dailyRow?.firstTokenRuns),
        usageMissingRuns: nums(dailyRow?.usageMissingRuns),
      })
      await manager.getRepository(AiUsageDailyEntity).save(daily)

      const dimensions = [
        ...(await manager.query<DimensionRow[]>(MODEL_SQL, [statDate])).map((row) =>
          this.dimensionOf(statDate, 'model', row),
        ),
        ...(await manager.query<DimensionRow[]>(AGENT_SQL, [statDate])).map((row) =>
          this.dimensionOf(statDate, 'agent', row),
        ),
        ...(await manager.query<DimensionRow[]>(TOOL_SQL, [statDate])).map((row) =>
          this.dimensionOf(statDate, 'tool', row),
        ),
      ]
      if (dimensions.length > 0) {
        await manager.getRepository(AiUsageDailyDimensionEntity).save(dimensions)
      }
    })
  }

  /** 回填区间（含首尾），单次最多 90 天 */
  async rollupRange(from: string, to: string): Promise<number> {
    const dates = enumerateDates(from, to)
    if (dates.length > 90) throw new Error('AI 用量回填最多 90 天')
    for (const date of dates) await this.rollupDay(date)
    this.logger.log('ai.usage.rollup_range', { from, to, days: dates.length })
    return dates.length
  }

  /** 定时任务：今天 + 昨天（昨天用于收尾跨午夜 / 晚到终态） */
  async rollupRecent(): Promise<void> {
    const [today, yesterday] = recentShanghaiDates()
    await this.rollupDay(today)
    await this.rollupDay(yesterday)
  }

  private dimensionOf(
    statDate: string,
    dimensionType: string,
    row: DimensionRow,
  ): AiUsageDailyDimensionEntity {
    return {
      id: nanoid(),
      statDate,
      dimensionType,
      dimensionKey: row.key ?? (dimensionType === 'tool' ? '未知工具' : '未记录'),
      conversations: nums(row.conversations),
      runs: nums(row.runs),
      succeeded: nums(row.succeeded),
      failed: nums(row.failed),
      totalTokens: nums(row.totalTokens),
      inputTokens: nums(row.inputTokens),
      outputTokens: nums(row.outputTokens),
      calls: nums(row.calls),
      toolSucceeded: nums(row.toolSucceeded),
      toolFailed: nums(row.toolFailed),
      toolDenied: nums(row.toolDenied),
      toolInvalid: nums(row.toolInvalid),
      toolUnknown: nums(row.toolUnknown),
      toolNoResult: nums(row.toolNoResult),
      durationMs: nums(row.durationMs),
      metadata: null,
    } as AiUsageDailyDimensionEntity
  }
}

interface DailyRow {
  conversations: unknown
  newConversations: unknown
  activeUsers: unknown
  runs: unknown
  succeeded: unknown
  failed: unknown
  canceled: unknown
  interrupted: unknown
  totalTokens: unknown
  inputTokens: unknown
  outputTokens: unknown
  cacheReadTokens: unknown
  cacheWriteTokens: unknown
  reasoningTokens: unknown
  steps: unknown
  toolCalls: unknown
  toolSucceeded: unknown
  toolFailed: unknown
  toolDenied: unknown
  toolInvalid: unknown
  toolUnknown: unknown
  toolNoResult: unknown
  runDurationMs: unknown
  firstTokenMsSum: unknown
  firstTokenRuns: unknown
  usageMissingRuns: unknown
}

interface DimensionRow {
  key: string | null
  conversations: unknown
  runs: unknown
  succeeded: unknown
  failed: unknown
  totalTokens: unknown
  inputTokens: unknown
  outputTokens: unknown
  calls: unknown
  toolSucceeded: unknown
  toolFailed: unknown
  toolDenied: unknown
  toolInvalid: unknown
  toolUnknown: unknown
  toolNoResult: unknown
  durationMs: unknown
}

const enumerateDates = (from: string, to: string): string[] => {
  const dates: string[] = []
  let current = from
  for (let i = 0; i < 366; i++) {
    dates.push(current)
    if (current === to) break
    current = addDays(current, 1)
  }
  return dates
}

const DAILY_SQL = `
WITH root AS (
  SELECT *
  FROM runs
  WHERE parent_run_id IS NULL
    AND (COALESCE(started_at, created_at) AT TIME ZONE 'Asia/Shanghai')::date = $1
),
new_conv AS (
  SELECT COUNT(*)::int AS count
  FROM conversations
  WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date = $1
),
tool_calls AS (
  SELECT c.run_id, c.tool_call_id, c.tool_key
  FROM timelines c
  WHERE c.kind = 'tool-call'
    AND (COALESCE(c.started_at, c.created_at) AT TIME ZONE 'Asia/Shanghai')::date = $1
),
tool_results AS (
  SELECT r.run_id, r.tool_call_id, r.state, r.duration_ms
  FROM timelines r
  WHERE r.kind = 'tool-result'
),
tool AS (
  SELECT
    COUNT(*)::int AS calls,
    COUNT(*) FILTER (WHERE r.state = 'output-available')::int AS succeeded,
    COUNT(*) FILTER (WHERE r.state = 'output-error')::int AS failed,
    COUNT(*) FILTER (WHERE r.state = 'denied')::int AS denied,
    COUNT(*) FILTER (WHERE r.state = 'invalid')::int AS invalid,
    COUNT(*) FILTER (WHERE r.state = 'unknown-tool')::int AS unknown,
    COUNT(*) FILTER (WHERE r.tool_call_id IS NULL)::int AS no_result,
    COALESCE(SUM(r.duration_ms), 0)::bigint AS duration
  FROM tool_calls c
  LEFT JOIN tool_results r ON r.run_id = c.run_id AND r.tool_call_id = c.tool_call_id
)
SELECT
  (SELECT COUNT(DISTINCT conversation_id)::int FROM root) AS "conversations",
  (SELECT count FROM new_conv) AS "newConversations",
  (SELECT COUNT(DISTINCT triggered_by)::int FROM root WHERE triggered_by IS NOT NULL) AS "activeUsers",
  (SELECT COUNT(*)::int FROM root) AS "runs",
  (SELECT COUNT(*) FILTER (WHERE status = 'succeeded')::int FROM root) AS "succeeded",
  (SELECT COUNT(*) FILTER (WHERE status = 'failed')::int FROM root) AS "failed",
  (SELECT COUNT(*) FILTER (WHERE status = 'canceled')::int FROM root) AS "canceled",
  (SELECT COUNT(*) FILTER (WHERE status = 'interrupted')::int FROM root) AS "interrupted",
  (SELECT COALESCE(SUM(NULLIF(usage->>'totalTokens', '')::bigint), 0)::bigint FROM root) AS "totalTokens",
  (SELECT COALESCE(SUM(NULLIF(usage->>'inputTokens', '')::bigint), 0)::bigint FROM root) AS "inputTokens",
  (SELECT COALESCE(SUM(NULLIF(usage->>'outputTokens', '')::bigint), 0)::bigint FROM root) AS "outputTokens",
  (SELECT COALESCE(SUM(NULLIF(usage->>'cacheReadTokens', '')::bigint), 0)::bigint FROM root) AS "cacheReadTokens",
  (SELECT COALESCE(SUM(NULLIF(usage->>'cacheWriteTokens', '')::bigint), 0)::bigint FROM root) AS "cacheWriteTokens",
  (SELECT COALESCE(SUM(NULLIF(usage->>'reasoningTokens', '')::bigint), 0)::bigint FROM root) AS "reasoningTokens",
  (SELECT COALESCE(SUM(step_count), 0)::int FROM root) AS "steps",
  (SELECT calls FROM tool) AS "toolCalls",
  (SELECT succeeded FROM tool) AS "toolSucceeded",
  (SELECT failed FROM tool) AS "toolFailed",
  (SELECT denied FROM tool) AS "toolDenied",
  (SELECT invalid FROM tool) AS "toolInvalid",
  (SELECT unknown FROM tool) AS "toolUnknown",
  (SELECT no_result FROM tool) AS "toolNoResult",
  (SELECT COALESCE(SUM(duration_ms), 0)::bigint FROM root) AS "runDurationMs",
  (SELECT COALESCE(SUM(first_token_ms), 0)::bigint FROM root) AS "firstTokenMsSum",
  (SELECT COUNT(*) FILTER (WHERE first_token_ms IS NOT NULL)::int FROM root) AS "firstTokenRuns",
  (SELECT COUNT(*) FILTER (WHERE usage IS NULL OR usage = '{}'::jsonb)::int FROM root) AS "usageMissingRuns"
`

const MODEL_SQL = `
SELECT
  COALESCE(NULLIF(request_snapshot->>'model', ''), '未记录') AS key,
  COUNT(DISTINCT conversation_id)::int AS conversations,
  COUNT(*)::int AS runs,
  COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
  COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
  COALESCE(SUM(NULLIF(usage->>'totalTokens', '')::bigint), 0)::bigint AS "totalTokens",
  COALESCE(SUM(NULLIF(usage->>'inputTokens', '')::bigint), 0)::bigint AS "inputTokens",
  COALESCE(SUM(NULLIF(usage->>'outputTokens', '')::bigint), 0)::bigint AS "outputTokens"
FROM runs
WHERE parent_run_id IS NULL
  AND (COALESCE(started_at, created_at) AT TIME ZONE 'Asia/Shanghai')::date = $1
GROUP BY 1
`

const AGENT_SQL = `
SELECT
  agent_key AS key,
  COUNT(DISTINCT conversation_id)::int AS conversations,
  COUNT(*)::int AS runs,
  COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
  COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
  COALESCE(SUM(NULLIF(usage->>'totalTokens', '')::bigint), 0)::bigint AS "totalTokens",
  COALESCE(SUM(NULLIF(usage->>'inputTokens', '')::bigint), 0)::bigint AS "inputTokens",
  COALESCE(SUM(NULLIF(usage->>'outputTokens', '')::bigint), 0)::bigint AS "outputTokens"
FROM runs
WHERE parent_run_id IS NULL
  AND (COALESCE(started_at, created_at) AT TIME ZONE 'Asia/Shanghai')::date = $1
GROUP BY 1
`

const TOOL_SQL = `
WITH calls AS (
  SELECT c.run_id, c.tool_call_id, COALESCE(c.tool_key, '未知工具') AS tool_key
  FROM timelines c
  WHERE c.kind = 'tool-call'
    AND (COALESCE(c.started_at, c.created_at) AT TIME ZONE 'Asia/Shanghai')::date = $1
),
results AS (
  SELECT r.run_id, r.tool_call_id, r.state, r.duration_ms
  FROM timelines r
  WHERE r.kind = 'tool-result'
)
SELECT
  c.tool_key AS key,
  COUNT(*)::int AS calls,
  COUNT(*) FILTER (WHERE r.state = 'output-available')::int AS "toolSucceeded",
  COUNT(*) FILTER (WHERE r.state = 'output-error')::int AS "toolFailed",
  COUNT(*) FILTER (WHERE r.state = 'denied')::int AS "toolDenied",
  COUNT(*) FILTER (WHERE r.state = 'invalid')::int AS "toolInvalid",
  COUNT(*) FILTER (WHERE r.state = 'unknown-tool')::int AS "toolUnknown",
  COUNT(*) FILTER (WHERE r.tool_call_id IS NULL)::int AS "toolNoResult",
  COALESCE(SUM(r.duration_ms), 0)::bigint AS "durationMs"
FROM calls c
LEFT JOIN results r ON r.run_id = c.run_id AND r.tool_call_id = c.tool_call_id
GROUP BY c.tool_key
`
