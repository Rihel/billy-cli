import { Inject, Injectable } from '@nestjs/common'
import { Db, DbService } from '@repo/kits'
import { nanoid } from '@repo/shared'
import { MonitorMetricSampleEntity } from '../../../database/entities/monitor-metric-sample-entity.js'
import type { MetricSample } from '../definitions/metric.types.js'
import type { MonitorMetricSeriesDto } from '@repo/shared'

/** 指标样本仓储：只做 monitor_metric_samples 的读写 */
@Injectable()
export class MetricSampleRepository {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(DbService) private readonly dbService: DbService,
  ) {}

  private async repo() {
    return this.db.getRepository(MonitorMetricSampleEntity)
  }

  /** 批量 upsert（唯一键冲突则更新值） */
  async upsertMany(samples: readonly MetricSample[]): Promise<void> {
    if (samples.length === 0) return
    await this.dbService.batchUpsert(
      MonitorMetricSampleEntity,
      samples.map((sample) => ({
        id: nanoid(),
        metricKind: sample.metricKind,
        metricKey: sample.metricKey,
        windowKey: sample.windowKey,
        windowStart: sample.windowStart,
        windowEnd: sample.windowEnd,
        instanceId: sample.instanceId,
        dimensionType: sample.dimensionType,
        dimensionKey: sample.dimensionKey,
        value: sample.value,
        labels: sample.labels ?? null,
      })),
      ['metricKey', 'windowKey', 'instanceId', 'dimensionType', 'dimensionKey'],
    )
  }

  /** 某窗口、某实例、某维度的 raw 值（衍生指标计算用） */
  async rawValues(
    metricKeys: readonly string[],
    windowKey: string,
    instanceId: string,
    dimensionType: string,
    dimensionKey: string,
  ): Promise<Map<string, number>> {
    if (metricKeys.length === 0) return new Map()
    const repo = await this.repo()
    const rows = await repo
      .createQueryBuilder('s')
      .where('s.metricKey IN (:...metricKeys)', { metricKeys })
      .andWhere('s.windowKey = :windowKey', { windowKey })
      .andWhere('s.instanceId = :instanceId', { instanceId })
      .andWhere('s.dimensionType = :dimensionType', { dimensionType })
      .andWhere('s.dimensionKey = :dimensionKey', { dimensionKey })
      .getMany()
    return new Map(rows.map((row) => [row.metricKey, row.value]))
  }

  /** 某窗口里出现过的维度组合（衍生指标逐维度计算用） */
  async dimensionsOf(
    metricKeys: readonly string[],
    windowKey: string,
    instanceId: string,
  ): Promise<Array<{ dimensionType: string; dimensionKey: string }>> {
    if (metricKeys.length === 0) return []
    const repo = await this.repo()
    const rows = await repo
      .createQueryBuilder('s')
      .select(['s.dimensionType AS "dimensionType"', 's.dimensionKey AS "dimensionKey"'])
      .where('s.metricKey IN (:...metricKeys)', { metricKeys })
      .andWhere('s.windowKey = :windowKey', { windowKey })
      .andWhere('s.instanceId = :instanceId', { instanceId })
      .distinct(true)
      .getRawMany<{ dimensionType: string; dimensionKey: string }>()
    return rows
  }

  /** 规则评估用：截止某时刻、最近 lookback 个窗口的样本（实例指标留一个周期写入时间） */
  async forRule(
    metricKey: string,
    cutoff: Date,
    lookback: number,
    intervalSeconds: number,
    dimensionType?: string,
    dimensionKey?: string,
  ): Promise<MetricSample[]> {
    const repo = await this.repo()
    const builder = repo
      .createQueryBuilder('s')
      .where('s.metricKey = :metricKey', { metricKey })
      .andWhere('s.windowEnd <= :cutoff', { cutoff })
      .orderBy('s.windowEnd', 'DESC')
      .addOrderBy('s.instanceId', 'ASC')
      .take(Math.max(lookback * 200, 500))
    if (dimensionType !== undefined) {
      builder.andWhere('s.dimensionType = :dimensionType', { dimensionType })
    }
    if (dimensionKey !== undefined) {
      builder.andWhere('s.dimensionKey = :dimensionKey', { dimensionKey })
    }
    const rows = await builder.getMany()
    return rows.map((row) => this.toSample(row))
  }

  /** 指标历史（控制台趋势） */
  async series(query: MonitorMetricSeriesDto): Promise<MetricSample[]> {
    const repo = await this.repo()
    const builder = repo
      .createQueryBuilder('s')
      .where('s.metricKey = :metricKey', { metricKey: query.metricKey })
      .orderBy('s.windowEnd', 'DESC')
      .take(query.limit)
    if (query.dimensionType !== undefined) {
      builder.andWhere('s.dimensionType = :dimensionType', { dimensionType: query.dimensionType })
    }
    if (query.dimensionKey !== undefined) {
      builder.andWhere('s.dimensionKey = :dimensionKey', { dimensionKey: query.dimensionKey })
    }
    if (query.instanceId !== undefined) {
      builder.andWhere('s.instanceId = :instanceId', { instanceId: query.instanceId })
    }
    if (query.from !== undefined) {
      builder.andWhere('s.windowEnd >= :from', { from: new Date(query.from) })
    }
    if (query.to !== undefined) {
      builder.andWhere('s.windowEnd <= :to', { to: new Date(query.to) })
    }
    const rows = await builder.getMany()
    return rows.reverse().map((row) => this.toSample(row))
  }

  /** 最新值（按指标 + 维度） */
  async latest(
    metricKeys: readonly string[],
    dimensionType?: string,
    dimensionKey?: string,
  ): Promise<MetricSample[]> {
    const repo = await this.repo()
    const result: MetricSample[] = []
    for (const metricKey of metricKeys) {
      const builder = repo
        .createQueryBuilder('s')
        .where('s.metricKey = :metricKey', { metricKey })
        .orderBy('s.windowEnd', 'DESC')
        .take(1)
      if (dimensionType !== undefined) {
        builder.andWhere('s.dimensionType = :dimensionType', { dimensionType })
      }
      if (dimensionKey !== undefined) {
        builder.andWhere('s.dimensionKey = :dimensionKey', { dimensionKey })
      }
      const row = await builder.getOne()
      if (row) result.push(this.toSample(row))
    }
    return result
  }

  /** 某指标最近样本时间（引擎状态 / 陈旧判断） */
  async lastWindowEnd(metricKey: string): Promise<Date | null> {
    const repo = await this.repo()
    const row = await repo.findOne({
      where: { metricKey },
      order: { windowEnd: 'DESC' },
    })
    return row?.windowEnd ?? null
  }

  /** 删除保留期之前的样本（分批，避免长事务） */
  async deleteOlderThan(cutoff: Date): Promise<number> {
    const repo = await this.repo()
    let deleted = 0
    for (let i = 0; i < 100; i++) {
      const rows = await repo
        .createQueryBuilder('s')
        .select('s.id', 'id')
        .where('s.windowEnd < :cutoff', { cutoff })
        .limit(1000)
        .getRawMany<{ id: string }>()
      if (rows.length === 0) break
      await repo.delete(rows.map((row) => row.id))
      deleted += rows.length
      if (rows.length < 1000) break
    }
    return deleted
  }

  private toSample(row: MonitorMetricSampleEntity): MetricSample {
    return {
      metricKey: row.metricKey,
      metricKind: row.metricKind as MetricSample['metricKind'],
      windowKey: row.windowKey,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      instanceId: row.instanceId,
      dimensionType: row.dimensionType,
      dimensionKey: row.dimensionKey,
      value: row.value,
      labels: row.labels ?? undefined,
    }
  }
}
