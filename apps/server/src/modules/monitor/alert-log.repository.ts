import { pageWith, type PageQueryResult } from '@repo/kits'
import { AlertLogEntity } from '../../database/entities/alert-log-entity.js'
import type { PageQueryAlertLogDto } from '@repo/shared'
import { Inject, Injectable } from '@repo/di'
import { Db } from '@repo/kits'

const toLog = (record: AlertLogEntity): Omit<AlertLogEntity, 'deletedAt' | 'generateId'> => {
  const { deletedAt: _deletedAt, ...log } = record
  return log
}

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

  async page(
    query: PageQueryAlertLogDto,
  ): Promise<PageQueryResult<Omit<AlertLogEntity, 'deletedAt' | 'generateId'>>> {
    const { page, size, ruleId, channel, status, orderBy = 'sentAt', order = 'desc' } = query
    const repo = await this.repo()
    const builder = repo.createQueryBuilder('l')
    if (ruleId) {
      builder.andWhere('l.ruleId = :ruleId', { ruleId })
    }
    if (channel) {
      builder.andWhere('l.channel = :channel', { channel })
    }
    if (status) {
      builder.andWhere('l.status = :status', { status })
    }
    builder.orderBy(`l.${orderBy}`, order === 'asc' ? 'ASC' : 'DESC')
    const { data, total } = await pageWith(builder, page, size)
    return { items: data.map(toLog), total, page, size }
  }
}
