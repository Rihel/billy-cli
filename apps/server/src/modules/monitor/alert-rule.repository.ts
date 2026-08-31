import { pageWith, type PageQueryResult } from '@repo/kits'
import { AlertRuleEntity } from '../../database/entities/alert-rule-entity.js'
import type { PageQueryAlertRuleDto } from '@repo/shared'
import { type DeepPartial } from 'typeorm'
import { Inject, Injectable } from '@repo/di'
import { Db } from '@repo/kits'

const toRule = (record: AlertRuleEntity): Omit<AlertRuleEntity, 'deletedAt' | 'generateId'> => {
  const { deletedAt: _deletedAt, ...rule } = record
  return rule
}

@Injectable()
export class AlertRuleRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(AlertRuleEntity)
  }

  async create(data: DeepPartial<AlertRuleEntity>): Promise<AlertRuleEntity> {
    const repo = await this.repo()
    const record = repo.create(data)
    return repo.save(record)
  }

  async findById(id: string): Promise<AlertRuleEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ id })
  }

  /** 按名称查找（唯一校验用；软删除不参与） */
  async findByName(name: string): Promise<AlertRuleEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ name })
  }

  /** 全部启用规则（AlertTrigger 告警匹配用，规则表数据量小，全量内存匹配） */
  async findAllEnabled(): Promise<AlertRuleEntity[]> {
    const repo = await this.repo()
    return repo.findBy({ enabled: true })
  }

  async update(
    id: string,
    data: DeepPartial<AlertRuleEntity>,
  ): Promise<AlertRuleEntity | null> {
    const repo = await this.repo()
    const existing = await repo.findOneBy({ id })
    if (!existing) return null
    Object.assign(existing, data)
    return repo.save(existing)
  }

  async remove(id: string): Promise<AlertRuleEntity | null> {
    const repo = await this.repo()
    const existing = await repo.findOneBy({ id })
    if (!existing) return null
    await repo.remove(existing)
    return existing
  }

  async page(
    query: PageQueryAlertRuleDto,
  ): Promise<PageQueryResult<Omit<AlertRuleEntity, 'deletedAt' | 'generateId'>>> {
    const { page, size, keyword, type, enabled, orderBy = 'updatedAt', order = 'desc' } = query
    const repo = await this.repo()
    const builder = repo.createQueryBuilder('r')
    if (keyword) {
      builder.andWhere('r.name ILIKE :keyword', { keyword: `%${keyword}%` })
    }
    if (type) {
      builder.andWhere('r.type = :type', { type })
    }
    if (enabled !== undefined) {
      builder.andWhere('r.enabled = :enabled', { enabled })
    }
    builder.orderBy(`r.${orderBy}`, order === 'asc' ? 'ASC' : 'DESC')
    const { data, total } = await pageWith(builder, page, size)
    return { items: data.map(toRule), total, page, size }
  }
}
