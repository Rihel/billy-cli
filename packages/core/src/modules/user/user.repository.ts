import { pageWith, type PageQueryResult, UserEntity } from '@repo/db'
import type { PageQueryUserDto, UserModel } from '@repo/shared'
import { Brackets, type DeepPartial } from 'typeorm'
import { Inject, Injectable } from '../../composition/di.js'
import { Db } from '../../infrastructure/database.js'

export type UserRecord = UserEntity

export const toUser = (record: UserEntity): UserModel => {
  const {
    password: _password,
    resetPasswordToken: _resetPasswordToken,
    resetPasswordTokenExpiry: _resetPasswordTokenExpiry,
    deletedAt: _deletedAt,
    ...user
  } = record
  return user
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
    const { page, size, keyword, orderBy = 'createdAt', order = 'desc' } = query
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
    builder.orderBy(`u.${orderBy}`, order === 'asc' ? 'ASC' : 'DESC')
    const { data, total } = await pageWith(builder, page, size)
    return { items: data.map(toUser), total, page, size }
  }
}
