import { Inject, Injectable } from '@nestjs/common'
import { Db, pageWith, type PageQueryResult } from '@repo/kits'
import type { MonitorAlertDeliveryModel, PageQueryMonitorLogDto } from '@repo/shared'
import { AlertLogEntity } from '../../../database/entities/alert-log-entity.js'

/** 发送记录仓储：只做 alert_logs 的读写 */
@Injectable()
export class AlertLogRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(AlertLogEntity)
  }

  async save(data: Partial<AlertLogEntity>): Promise<AlertLogEntity> {
    const repo = await this.repo()
    return repo.save(repo.create(data))
  }

  async listByAlertId(alertId: string): Promise<MonitorAlertDeliveryModel[]> {
    const repo = await this.repo()
    const rows = await repo.find({
      where: { alertId },
      order: { sentAt: 'DESC' },
    })
    return rows.map((row) => this.toModel(row))
  }

  async page(
    query: PageQueryMonitorLogDto,
  ): Promise<PageQueryResult<MonitorAlertDeliveryModel>> {
    const { page, size, alertId, ruleId, channel, status, from, to } = query
    const repo = await this.repo()
    const builder = repo.createQueryBuilder('l')
    if (alertId) builder.andWhere('l.alertId = :alertId', { alertId })
    if (ruleId) builder.andWhere('l.ruleId = :ruleId', { ruleId })
    if (channel) builder.andWhere('l.channel = :channel', { channel })
    if (status) builder.andWhere('l.status = :status', { status })
    if (from) builder.andWhere('l.sentAt >= :from', { from: new Date(from) })
    if (to) builder.andWhere('l.sentAt <= :to', { to: new Date(to) })
    builder.orderBy(`l.${query.orderBy}`, query.order === 'asc' ? 'ASC' : 'DESC')
    const { data, total } = await pageWith(builder, page, size)
    return {
      items: data.map((row) => this.toModel(row)),
      total,
      page,
      size,
    }
  }

  private toModel(row: AlertLogEntity): MonitorAlertDeliveryModel {
    return {
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      alertId: row.alertId,
      ruleId: row.ruleId,
      ruleName: row.ruleName,
      title: row.title,
      message: row.message,
      channel: row.channel as MonitorAlertDeliveryModel['channel'],
      status: row.status as MonitorAlertDeliveryModel['status'],
      error: row.error,
      sentAt: row.sentAt,
    }
  }
}
