import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import { AiMarketItemEntity } from '@repo/db'
import type { MarketItemListDto } from '@repo/shared'

@Injectable()
export class MarketRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private repo() {
    return this.db.getRepository(AiMarketItemEntity)
  }

  async list(query: MarketItemListDto): Promise<AiMarketItemEntity[]> {
    return this.repo().find({
      where: {
        ...(query.type ? { type: query.type } : {}),
        ...(query.scope ? { scope: query.scope } : {}),
      },
      order: { createdAt: 'DESC' },
    })
  }

  async findByKey(key: string): Promise<AiMarketItemEntity | null> {
    return this.repo().findOne({ where: { key } })
  }

  async upsert(data: {
    key: string
    name: string
    description: string | null
    category: string | null
    type: string
    scope: string
    payload: Record<string, unknown>
    icon: string | null
  }): Promise<AiMarketItemEntity> {
    const repo = this.repo()
    const existing = await this.findByKey(data.key)
    if (existing) {
      Object.assign(existing, data)
      return repo.save(existing)
    }
    return repo.save(repo.create(data))
  }

  async softRemove(key: string): Promise<boolean> {
    const result = await this.repo().softDelete({ key })
    return (result.affected ?? 0) > 0
  }
}
