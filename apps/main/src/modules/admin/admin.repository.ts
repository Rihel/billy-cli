import { pageWith, type PageQueryResult, Db } from '@repo/kits'
import { AdminEntity } from '@repo/db'
import type { AdminModel, PageQueryAdminDto } from '@repo/shared'
import { Brackets, type DeepPartial } from 'typeorm'
import { Inject, Injectable } from '@nestjs/common'

export type AdminRecord = AdminEntity

/** 数据库记录 → 对外模型：剔除敏感字段，并将 status 收敛为枚举字面量 */
export const toAdmin = (record: AdminEntity): AdminModel => {
  const { password: _password, deletedAt: _deletedAt, status, ...admin } = record
  return {
    ...admin,
    status: status as AdminModel['status'],
  }
}

@Injectable()
export class AdminRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(AdminEntity)
  }

  async findById(id: string): Promise<AdminEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ id })
  }

  async findByEmail(email: string): Promise<AdminEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ email })
  }

  /** 按类型计数（软删不计）；最后一个超管的判定与种子服务都用它 */
  async countByType(type: string): Promise<number> {
    const repo = await this.repo()
    return repo.count({ where: { type } })
  }

  /** 按类型计数，**含软删**：区分「从来没建过超管」与「超管被删了」（后者不自动重建） */
  async countByTypeIncludingDeleted(type: string): Promise<number> {
    const repo = await this.repo()
    return repo.count({ where: { type }, withDeleted: true })
  }

  async create(data: DeepPartial<AdminEntity>): Promise<AdminEntity> {
    const repo = await this.repo()
    return repo.save(repo.create(data))
  }

  async update(id: string, data: DeepPartial<AdminEntity>): Promise<AdminEntity | null> {
    const repo = await this.repo()
    const existing = await repo.findOneBy({ id })
    if (!existing) return null
    Object.assign(existing, data)
    return repo.save(existing)
  }

  async remove(id: string): Promise<AdminEntity | null> {
    const repo = await this.repo()
    const existing = await repo.findOneBy({ id })
    if (!existing) return null
    await repo.remove(existing)
    return existing
  }

  async page(query: PageQueryAdminDto): Promise<PageQueryResult<AdminModel>> {
    const { page, size, keyword, status, orderBy = 'createdAt', order = 'desc' } = query
    const repo = await this.repo()
    const builder = repo.createQueryBuilder('a')
    if (keyword) {
      builder.andWhere(
        new Brackets((qb) => {
          qb.where('a.email ILIKE :keyword', {
            keyword: `%${keyword}%`,
          }).orWhere('a.realName ILIKE :keyword', { keyword: `%${keyword}%` })
        }),
      )
    }
    if (status) {
      builder.andWhere('a.status = :status', { status })
    }
    builder.orderBy(`a.${orderBy}`, order === 'asc' ? 'ASC' : 'DESC')
    const { data, total } = await pageWith(builder, page, size)
    return { items: data.map(toAdmin), total, page, size }
  }
}
