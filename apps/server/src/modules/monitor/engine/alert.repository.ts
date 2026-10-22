import { Inject, Injectable } from '@nestjs/common'
import { Db, pageWith } from '@repo/kits'
import type { PageQueryResult } from '@repo/kits'
import type { MonitorAlertModel, PageQueryMonitorAlertDto } from '@repo/shared'
import { MonitorAlertEntity } from '../../../database/entities/monitor-alert-entity.js'
import type { QueryDeepPartialEntity } from 'typeorm'

export interface FiringAlertInput {
  ruleKey: string
  ruleName: string
  kind: 'metric' | 'event'
  level: 'warn' | 'error' | 'critical'
  subjectId: string
  instanceId: string
  value: number
  threshold: number
  windowKey: string
  snapshot: Record<string, unknown>
  now: Date
}

/** 告警记录仓储：只做 monitor_alerts 的读写 */
@Injectable()
export class AlertRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(MonitorAlertEntity)
  }

  /** 首次 / 再次命中：同一规则同一主体只有一条 firing */
  async upsertFiring(input: FiringAlertInput): Promise<MonitorAlertEntity> {
    const repo = await this.repo()
    const existing = await repo.findOne({
      where: { ruleKey: input.ruleKey, subjectId: input.subjectId, status: 'firing' },
    })
    if (existing) {
      await repo.update(existing.id, {
        lastFiredAt: input.now,
        level: input.level,
        value: input.value,
        threshold: input.threshold,
        windowKey: input.windowKey,
        lastSnapshot: input.snapshot,
        missCount: 0,
      } as QueryDeepPartialEntity<MonitorAlertEntity>)
      return (await repo.findOneByOrFail({ id: existing.id }))
    }
    return repo.save(
      repo.create({
        ruleKey: input.ruleKey,
        ruleName: input.ruleName,
        kind: input.kind,
        level: input.level,
        subjectId: input.subjectId,
        instanceId: input.instanceId,
        status: 'firing',
        firstFiredAt: input.now,
        lastFiredAt: input.now,
        value: input.value,
        threshold: input.threshold,
        windowKey: input.windowKey,
        firstSnapshot: input.snapshot,
        lastSnapshot: input.snapshot,
        missCount: 0,
      }),
    )
  }

  async findOpenByRule(ruleKey: string): Promise<MonitorAlertEntity[]> {
    const repo = await this.repo()
    return repo.find({ where: { ruleKey, status: 'firing' } })
  }

  async findOpenByKind(kind: 'metric' | 'event'): Promise<MonitorAlertEntity[]> {
    const repo = await this.repo()
    return repo.find({ where: { kind, status: 'firing' } })
  }

  async findByRuleSubject(ruleKey: string, subjectId: string): Promise<MonitorAlertEntity | null> {
    const repo = await this.repo()
    return repo.findOne({
      where: { ruleKey, subjectId, status: 'firing' },
    })
  }

  async findById(id: string): Promise<MonitorAlertEntity | null> {
    const repo = await this.repo()
    return repo.findOne({ where: { id } })
  }

  async findModelById(id: string): Promise<MonitorAlertModel | null> {
    const row = await this.findById(id)
    return row ? this.toModel(row) : null
  }

  async markMiss(alertId: string): Promise<number> {
    const repo = await this.repo()
    await repo.increment({ id: alertId }, 'missCount', 1)
    const row = await repo.findOneByOrFail({ id: alertId })
    return row.missCount
  }

  async resolve(alert: MonitorAlertEntity, now: Date): Promise<void> {
    const repo = await this.repo()
    await repo.update(alert.id, {
      status: 'resolved',
      recoveredAt: now,
      durationMs: Math.max(0, now.getTime() - alert.firstFiredAt.getTime()),
    })
  }

  async resolveByRule(ruleKey: string, now: Date): Promise<number> {
    const repo = await this.repo()
    const rows = await this.findOpenByRule(ruleKey)
    for (const row of rows) await this.resolve(row, now)
    return rows.length
  }

  async page(query: PageQueryMonitorAlertDto): Promise<PageQueryResult<MonitorAlertModel>> {
    const repo = await this.repo()
    const builder = repo.createQueryBuilder('a')
    if (query.ruleKey) builder.andWhere('a.ruleKey = :ruleKey', { ruleKey: query.ruleKey })
    if (query.level) builder.andWhere('a.level = :level', { level: query.level })
    if (query.status) builder.andWhere('a.status = :status', { status: query.status })
    if (query.subjectId) builder.andWhere('a.subjectId = :subjectId', { subjectId: query.subjectId })
    if (query.from) builder.andWhere('a.firstFiredAt >= :from', { from: new Date(query.from) })
    if (query.to) builder.andWhere('a.firstFiredAt <= :to', { to: new Date(query.to) })
    builder.orderBy(`a.${query.orderBy}`, query.order === 'asc' ? 'ASC' : 'DESC')
    const { data, total } = await pageWith(builder, query.page, query.size)
    return {
      items: data.map((row) => this.toModel(row)),
      total,
      page: query.page,
      size: query.size,
    }
  }

  async lastFiredAt(ruleKey: string): Promise<Date | null> {
    const repo = await this.repo()
    const row = await repo.findOne({
      where: { ruleKey },
      order: { lastFiredAt: 'DESC' },
    })
    return row?.lastFiredAt ?? null
  }

  private toModel(row: MonitorAlertEntity): MonitorAlertModel {
    return {
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ruleKey: row.ruleKey,
      ruleName: row.ruleName,
      kind: row.kind as MonitorAlertModel['kind'],
      level: row.level as MonitorAlertModel['level'],
      subjectId: row.subjectId,
      instanceId: row.instanceId,
      status: row.status as MonitorAlertModel['status'],
      firstFiredAt: row.firstFiredAt,
      lastFiredAt: row.lastFiredAt,
      recoveredAt: row.recoveredAt,
      durationMs:
        row.durationMs ??
        (row.status === 'firing' ? Math.max(0, Date.now() - row.firstFiredAt.getTime()) : null),
      missCount: row.missCount,
      value: row.value,
      threshold: row.threshold,
      windowKey: row.windowKey,
      firstSnapshot: row.firstSnapshot as MonitorAlertModel['firstSnapshot'],
      lastSnapshot: row.lastSnapshot as MonitorAlertModel['lastSnapshot'],
    }
  }
}
