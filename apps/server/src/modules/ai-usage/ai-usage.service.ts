import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import type {
  AgentUsageBucketModel,
  AgentUsageDailyModel,
  AgentUsageSummaryModel,
} from '@repo/shared'
import { AiUsageDailyEntity } from '../../database/entities/ai-usage-daily-entity.js'
import { AiUsageDailyDimensionEntity } from '../../database/entities/ai-usage-daily-dimension-entity.js'
import {
  AiUsageRollupService,
  recentShanghaiDates,
  shanghaiDateKey,
} from './ai-usage.rollup.service.js'

export interface AiUsageDayData {
  daily: AiUsageDailyEntity | null
  dimensions: AiUsageDailyDimensionEntity[]
}

/** 读日表：控制台汇总 / AI 指标源共用 */
@Injectable()
export class AiUsageService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AiUsageRollupService) private readonly rollup: AiUsageRollupService,
  ) {}

  /** 某天的原始日表数据（AI 指标源用） */
  async day(statDate: string): Promise<AiUsageDayData> {
    const daily = await this.db.getRepository(AiUsageDailyEntity).findOne({
      where: { statDate },
    })
    const dimensions = await this.db.getRepository(AiUsageDailyDimensionEntity).find({
      where: { statDate },
    })
    return { daily, dimensions }
  }

  /** 控制台汇总：近 N 天，读日表而不是扫 runs */
  async summary(days: number): Promise<AgentUsageSummaryModel> {
    const [today] = recentShanghaiDates()
    const from = shiftDate(today, -(days - 1))
    const dailyRows = await this.db
      .getRepository(AiUsageDailyEntity)
      .createQueryBuilder('d')
      .where('d.statDate >= :from', { from })
      .andWhere('d.statDate <= :to', { to: today })
      .orderBy('d.statDate', 'ASC')
      .getMany()
    const dimensionRows = await this.db
      .getRepository(AiUsageDailyDimensionEntity)
      .createQueryBuilder('d')
      .where('d.statDate >= :from', { from })
      .andWhere('d.statDate <= :to', { to: today })
      .andWhere('d.dimensionType IN (:...types)', { types: ['model', 'agent'] })
      .getMany()

    const totals = dailyRows.reduce(
      (acc, row) => {
        acc.runs += row.runs
        acc.succeeded += row.succeeded
        acc.failed += row.failed
        acc.canceled += row.canceled
        acc.interrupted += row.interrupted
        acc.totalTokens += row.totalTokens
        acc.inputTokens += row.inputTokens
        acc.outputTokens += row.outputTokens
        acc.cacheReadTokens += row.cacheReadTokens
        acc.reasoningTokens += row.reasoningTokens
        acc.durationMs += row.runDurationMs
        acc.steps += row.steps
        acc.toolCalls += row.toolCalls
        return acc
      },
      {
        runs: 0,
        succeeded: 0,
        failed: 0,
        canceled: 0,
        interrupted: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        durationMs: 0,
        steps: 0,
        toolCalls: 0,
      },
    )
    const firstTokenRuns = dailyRows.reduce((sum, row) => sum + row.firstTokenRuns, 0)
    const firstTokenMsSum = dailyRows.reduce((sum, row) => sum + row.firstTokenMsSum, 0)

    const daily: AgentUsageDailyModel[] = enumerateDates(from, today).map((date) => {
      const row = dailyRows.find((item) => toDateKey(item.statDate) === date)
      return {
        date,
        runs: row?.runs ?? 0,
        totalTokens: row?.totalTokens ?? 0,
        inputTokens: row?.inputTokens ?? 0,
        outputTokens: row?.outputTokens ?? 0,
      }
    })

    return {
      days,
      since: `${from}T00:00:00.000Z`,
      totals: {
        ...totals,
        avgDurationMs: totals.runs > 0 ? Math.round(totals.durationMs / totals.runs) : 0,
        avgFirstTokenMs: firstTokenRuns > 0 ? Math.round(firstTokenMsSum / firstTokenRuns) : 0,
      },
      daily,
      byModel: aggregateBuckets(dimensionRows, 'model'),
      byAgent: aggregateBuckets(dimensionRows, 'agent'),
    }
  }

  /** 手动回填（管理员 / 初始化） */
  async backfill(from: string, to: string): Promise<number> {
    return this.rollup.rollupRange(from, to)
  }

  /** 今天 + 昨天的日期（供外部判断） */
  recentDates(): [string, string] {
    return recentShanghaiDates()
  }

  today(): string {
    return shanghaiDateKey(new Date())
  }
}

const aggregateBuckets = (
  rows: AiUsageDailyDimensionEntity[],
  type: 'model' | 'agent',
): AgentUsageBucketModel[] => {
  const map = new Map<string, AgentUsageBucketModel>()
  for (const row of rows) {
    if (row.dimensionType !== type) continue
    const current = map.get(row.dimensionKey) ?? { key: row.dimensionKey, runs: 0, totalTokens: 0 }
    current.runs += row.runs
    current.totalTokens += row.totalTokens
    map.set(row.dimensionKey, current)
  }
  return [...map.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens || b.runs - a.runs)
    .slice(0, 10)
}

const shiftDate = (date: string, days: number): string => {
  const base = new Date(`${date}T00:00:00.000Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

const enumerateDates = (from: string, to: string): string[] => {
  const dates: string[] = []
  let current = from
  for (let i = 0; i < 366; i++) {
    dates.push(current)
    if (current === to) break
    current = shiftDate(current, 1)
  }
  return dates
}


const toDateKey = (value: string | Date): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
