import { pageWith, type PageQueryResult } from '@repo/kits'
import { UserEntity } from '../../database/entities/user-entity.js'
import type { PageQueryUserDto, UserModel } from '@repo/shared'
import { Brackets, type DeepPartial } from 'typeorm'
import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'

export type UserRecord = UserEntity

export const toUser = (record: UserEntity): UserModel => {
  const {
    password: _password,
    resetPasswordToken: _resetPasswordToken,
    resetPasswordTokenExpiry: _resetPasswordTokenExpiry,
    deletedAt: _deletedAt,
    status,
    ...user
  } = record
  return {
    ...user,
    status: status as UserModel['status'],
  }
}

@Injectable()
export class UserRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(UserEntity)
  }

  async findById(id: string): Promise<UserEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ id })
  }

  async findByEmail(email: string): Promise<UserEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ email })
  }

  async findByResetToken(token: string): Promise<UserEntity | null> {
    const repo = await this.repo()
    return repo.findOneBy({ resetPasswordToken: token })
  }

  async create(data: DeepPartial<UserEntity>): Promise<UserEntity> {
    const repo = await this.repo()
    return repo.save(repo.create(data))
  }

  async update(
    id: string,
    data: DeepPartial<UserEntity>,
  ): Promise<UserEntity | null> {
    const repo = await this.repo()
    const existing = await repo.findOneBy({ id })
    if (!existing) return null
    Object.assign(existing, data)
    return repo.save(existing)
  }

  async remove(id: string): Promise<UserEntity | null> {
    const repo = await this.repo()
    const existing = await repo.findOneBy({ id })
    if (!existing) return null
    await repo.remove(existing)
    return existing
  }

  async page(query: PageQueryUserDto): Promise<PageQueryResult<UserModel>> {
    const { page, size, keyword, status, orderBy = 'createdAt', order = 'desc' } = query
    const repo = await this.repo()
    const builder = repo.createQueryBuilder('u')
    if (keyword) {
      builder.andWhere(
        new Brackets((qb) => {
          qb.where('u.email ILIKE :keyword', {
            keyword: `%${keyword}%`,
          }).orWhere('u.realName ILIKE :keyword', { keyword: `%${keyword}%` })
        }),
      )
    }
    if (status) {
      builder.andWhere('u.status = :status', { status })
    }
    builder.orderBy(`u.${orderBy}`, order === 'asc' ? 'ASC' : 'DESC')
    const { data, total } = await pageWith(builder, page, size)
    return { items: data.map(toUser), total, page, size }
  }
}
