import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { AiModelEntity, AiProviderEntity, ModelGatewayUsageEntity } from '@repo/db'
import { Db } from '@repo/kits'
import type {
  GatewayUsageDimensionModel,
  GatewayUsageItemModel,
  GatewayUsageListDto,
  GatewayUsageReconcileDto,
  GatewayUsageReconcileItemModel,
  GatewayUsageReconcileResultModel,
  GatewayUsageStatus,
  GatewayUsageSummaryModel,
  GatewayUsageSummaryQueryDto,
} from '@repo/shared'
import { In } from 'typeorm'

interface Range {
  from: string
  to: string
  start: Date
  end: Date
}

/**
 * 模型网关「调用账」查询：逐请求明细 + 汇总 + 与 `runs.usage` 对账。
 *
 * 口径与 `model_gateway_usage` 一致：**每次上游尝试一行**（含重试/失败），
 * 而 `runs.usage` 是业务口径（每轮 run、子 agent 已并入父 run）；两者不要求相等，
 * 对账只把差异找出来，不做自动修正。
 */
@Injectable()
export class GatewayUsageService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async list(input: GatewayUsageListDto): Promise<{
    items: GatewayUsageItemModel[]
    total: number
    page: number
    size: number
  }> {
    const range = this.rangeOf(input.from, input.to)
    const qb = this.baseQuery(range)
    if (input.providerId)
      qb.andWhere('g.providerId = :providerId', { providerId: input.providerId })
    if (input.modelId) qb.andWhere('g.modelId = :modelId', { modelId: input.modelId })
    if (input.runId) qb.andWhere('g.runId = :runId', { runId: input.runId })
    if (input.conversationId) {
      qb.andWhere('g.conversationId = :conversationId', {
        conversationId: input.conversationId,
      })
    }
    if (input.status) qb.andWhere('g.status = :status', { status: input.status })

    const [rows, total] = await qb
      .orderBy('g.createdAt', 'DESC')
      .skip((input.page - 1) * input.size)
      .take(input.size)
      .getManyAndCount()

    const providerIds = [...new Set(rows.map((row) => row.providerId).filter(Boolean))] as string[]
    const modelIds = [...new Set(rows.map((row) => row.modelId).filter(Boolean))] as string[]
    const [providers, models] = await Promise.all([
      providerIds.length
        ? this.db.getRepository(AiProviderEntity).find({ where: { id: In(providerIds) } })
        : [],
      modelIds.length
        ? this.db.getRepository(AiModelEntity).find({ where: { id: In(modelIds) } })
        : [],
    ])
    const providerNames = new Map(providers.map((row) => [row.id, row.name]))
    const modelNames = new Map(models.map((row) => [row.id, row.displayName]))
    const modelKeys = new Map(models.map((row) => [row.id, row.modelKey]))

    return {
      items: rows.map((row) => ({
        id: row.id,
        requestId: row.requestId,
        attempt: row.attempt,
        runId: row.runId,
        conversationId: row.conversationId,
        identityType: row.identityType,
        identityId: row.identityId,
        providerId: row.providerId,
        providerName: row.providerId ? (providerNames.get(row.providerId) ?? null) : null,
        modelId: row.modelId,
        modelKey: row.modelId ? (modelKeys.get(row.modelId) ?? null) : null,
        modelName: row.modelId ? (modelNames.get(row.modelId) ?? null) : null,
        keyId: row.keyId,
        stream: row.stream,
        status: row.status as GatewayUsageStatus,
        httpStatus: row.httpStatus,
        errorCode: row.errorCode,
        unitType: row.unitType,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        reasoningTokens: row.reasoningTokens,
        units: row.units,
        costMicros: row.costMicros,
        priceSnapshot: row.priceSnapshot,
        ttftMs: row.ttftMs,
        durationMs: row.durationMs,
        usageMissing: row.usageMissing,
        createdAt: row.createdAt,
      })),
      total,
      page: input.page,
      size: input.size,
    }
  }

  async summary(input: GatewayUsageSummaryQueryDto): Promise<GatewayUsageSummaryModel> {
    const range = this.rangeOf(input.from, input.to)
    const base = this.baseQuery(range)
    if (input.providerId)
      base.andWhere('g.providerId = :providerId', { providerId: input.providerId })
    if (input.modelId) base.andWhere('g.modelId = :modelId', { modelId: input.modelId })

    const totalsRow = await base
      .clone()
      .select([
        'COUNT(*)::int AS "calls"',
        `COUNT(*) FILTER (WHERE g.status = 'success')::int AS "success"`,
        `COUNT(*) FILTER (WHERE g.status = 'error')::int AS "error"`,
        `COUNT(*) FILTER (WHERE g.status = 'aborted')::int AS "aborted"`,
        `COUNT(*) FILTER (WHERE g.status = 'rejected')::int AS "rejected"`,
        'COALESCE(SUM(g.input_tokens), 0)::bigint AS "inputTokens"',
        'COALESCE(SUM(g.output_tokens), 0)::bigint AS "outputTokens"',
        'COALESCE(SUM(g.total_tokens), 0)::bigint AS "totalTokens"',
        'COALESCE(SUM(g.cache_read_tokens), 0)::bigint AS "cacheReadTokens"',
        'COALESCE(SUM(g.cache_write_tokens), 0)::bigint AS "cacheWriteTokens"',
        'COALESCE(SUM(g.reasoning_tokens), 0)::bigint AS "reasoningTokens"',
        'COALESCE(SUM(g.cost_micros), 0)::bigint AS "costMicros"',
        'COUNT(*) FILTER (WHERE g.usage_missing)::int AS "usageMissing"',
        'COALESCE(AVG(g.duration_ms), 0)::int AS "avgDurationMs"',
        'COALESCE(AVG(g.ttft_ms), 0)::int AS "avgTtftMs"',
      ])
      .getRawOne<Record<string, string | number>>()

    const byDay = await base
      .clone()
      .select([
        `to_char(g.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS "date"`,
        'COUNT(*)::int AS "calls"',
        'COALESCE(SUM(g.total_tokens), 0)::bigint AS "totalTokens"',
        'COALESCE(SUM(g.cost_micros), 0)::bigint AS "costMicros"',
      ])
      .groupBy(`to_char(g.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`)
      .orderBy('"date"', 'ASC')
      .getRawMany<Record<string, string | number>>()

    const byModel = await base
      .clone()
      .leftJoin(AiModelEntity, 'm', 'm.id = g.model_id')
      .leftJoin(AiProviderEntity, 'p', 'p.id = g.provider_id')
      .select([
        'g.model_id AS "key"',
        `COALESCE(m.display_name, g.model_id, '未知模型') AS "label"`,
        'COUNT(*)::int AS "calls"',
        'COALESCE(SUM(g.total_tokens), 0)::bigint AS "totalTokens"',
        'COALESCE(SUM(g.cost_micros), 0)::bigint AS "costMicros"',
      ])
      .groupBy('g.model_id')
      .addGroupBy('m.display_name')
      .addGroupBy('p.name')
      .orderBy('"costMicros"', 'DESC')
      .getRawMany<Record<string, string | number>>()

    const byProvider = await base
      .clone()
      .leftJoin(AiProviderEntity, 'p', 'p.id = g.provider_id')
      .select([
        'g.provider_id AS "key"',
        `COALESCE(p.name, g.provider_id, '未知供应商') AS "label"`,
        'COUNT(*)::int AS "calls"',
        'COALESCE(SUM(g.total_tokens), 0)::bigint AS "totalTokens"',
        'COALESCE(SUM(g.cost_micros), 0)::bigint AS "costMicros"',
      ])
      .groupBy('g.provider_id')
      .addGroupBy('p.name')
      .orderBy('"costMicros"', 'DESC')
      .getRawMany<Record<string, string | number>>()

    return {
      from: range.from,
      to: range.to,
      totals: {
        calls: num(totalsRow?.calls),
        success: num(totalsRow?.success),
        error: num(totalsRow?.error),
        aborted: num(totalsRow?.aborted),
        rejected: num(totalsRow?.rejected),
        inputTokens: num(totalsRow?.inputTokens),
        outputTokens: num(totalsRow?.outputTokens),
        totalTokens: num(totalsRow?.totalTokens),
        cacheReadTokens: num(totalsRow?.cacheReadTokens),
        cacheWriteTokens: num(totalsRow?.cacheWriteTokens),
        reasoningTokens: num(totalsRow?.reasoningTokens),
        costMicros: num(totalsRow?.costMicros),
        usageMissing: num(totalsRow?.usageMissing),
        avgDurationMs: num(totalsRow?.avgDurationMs),
        avgTtftMs: num(totalsRow?.avgTtftMs),
      },
      byDay: byDay.map((row) => ({
        date: String(row.date),
        calls: num(row.calls),
        totalTokens: num(row.totalTokens),
        costMicros: num(row.costMicros),
      })),
      byModel: byModel.map(toDimension),
      byProvider: byProvider.map(toDimension),
    }
  }

  async reconcile(input: GatewayUsageReconcileDto): Promise<GatewayUsageReconcileResultModel> {
    const range = this.rangeOf(input.from, input.to)
    const onlyDiff = input.onlyDiff ?? false
    const offset = (input.page - 1) * input.size
    const params = { start: range.start, end: range.end, onlyDiff, limit: input.size, offset }
    const having = onlyDiff
      ? `HAVING (MAX(r.id) IS NULL OR COALESCE(SUM(g.total_tokens), 0) <> COALESCE(MAX(r.usage->>'totalTokens')::bigint, 0))`
      : ''

    const rows = await this.db.dataSource.query<
      Array<{
        run_id: string
        conversation_id: string | null
        gateway_calls: string
        gateway_tokens: string
        run_tokens: string | null
        run_status: string | null
        run_created_at: string | null
      }>
    >(
      `
      SELECT g.run_id,
             MAX(g.conversation_id) AS conversation_id,
             COUNT(*)::int AS gateway_calls,
             COALESCE(SUM(g.total_tokens), 0)::bigint AS gateway_tokens,
             MAX(r.usage->>'totalTokens') AS run_tokens,
             MAX(r.status) AS run_status,
             MAX(r.created_at) AS run_created_at
        FROM model_gateway_usage g
        LEFT JOIN runs r ON r.id = g.run_id
       WHERE g.run_id IS NOT NULL
         AND g.created_at >= $1 AND g.created_at <= $2
       GROUP BY g.run_id
       ${having}
       ORDER BY MAX(g.created_at) DESC
       LIMIT $3 OFFSET $4
      `,
      [params.start, params.end, params.limit, params.offset],
    )

    const [counts] = await this.db.dataSource.query<
      Array<{ compared: string; mismatched: string; orphans: string }>
    >(
      `
      SELECT COUNT(*) FILTER (WHERE r.id IS NOT NULL)::int AS compared,
             COUNT(*) FILTER (
               WHERE r.id IS NOT NULL
                 AND COALESCE(g.tokens, 0) <> COALESCE((r.usage->>'totalTokens')::bigint, 0)
             )::int AS mismatched,
             COUNT(*) FILTER (WHERE r.id IS NULL)::int AS orphans
        FROM (
          SELECT g.run_id, SUM(g.total_tokens) AS tokens
            FROM model_gateway_usage g
           WHERE g.run_id IS NOT NULL AND g.created_at >= $1 AND g.created_at <= $2
           GROUP BY g.run_id
        ) g
        LEFT JOIN runs r ON r.id = g.run_id
      `,
      [params.start, params.end],
    )

    const items: GatewayUsageReconcileItemModel[] = rows.map((row) => {
      const gatewayTotal = num(row.gateway_tokens)
      const runTotal = row.run_tokens === null ? null : num(row.run_tokens)
      return {
        runId: row.run_id,
        conversationId: row.conversation_id,
        gatewayCalls: num(row.gateway_calls),
        gatewayTotalTokens: gatewayTotal,
        runTotalTokens: runTotal,
        delta: runTotal === null ? null : gatewayTotal - runTotal,
        runStatus: row.run_status,
        runCreatedAt: row.run_created_at ?? undefined,
      }
    })

    return {
      from: range.from,
      to: range.to,
      orphanRuns: num(counts?.orphans),
      comparedRuns: num(counts?.compared),
      mismatchRuns: num(counts?.mismatched),
      items,
      total: onlyDiff
        ? num(counts?.mismatched) + num(counts?.orphans)
        : num(counts?.compared) + num(counts?.orphans),
    }
  }

  private baseQuery(range: Range) {
    return this.db
      .getRepository(ModelGatewayUsageEntity)
      .createQueryBuilder('g')
      .where('g.createdAt >= :start', { start: range.start })
      .andWhere('g.createdAt <= :end', { end: range.end })
  }

  private rangeOf(from?: string, to?: string): Range {
    const today = shanghaiToday()
    const toKey = to ?? today
    const fromKey = from ?? shiftDate(toKey, -6)
    if (fromKey > toKey) throw new BadRequestException('开始日期不能晚于结束日期')
    return {
      from: fromKey,
      to: toKey,
      start: new Date(`${fromKey}T00:00:00+08:00`),
      end: new Date(`${toKey}T23:59:59.999+08:00`),
    }
  }
}

const num = (value: unknown): number => Number(value ?? 0)

const toDimension = (row: Record<string, string | number>): GatewayUsageDimensionModel => ({
  key: String(row.key ?? ''),
  label: String(row.label ?? row.key ?? '未知'),
  calls: num(row.calls),
  totalTokens: num(row.totalTokens),
  costMicros: num(row.costMicros),
})

const shanghaiToday = (): string =>
  new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)

const shiftDate = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
