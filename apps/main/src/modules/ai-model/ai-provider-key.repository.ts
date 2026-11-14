import { Inject, Injectable } from '@nestjs/common'
import { AiProviderKeyEntity } from '@repo/db'
import { Db } from '@repo/kits'
import type { DeepPartial } from 'typeorm'

/** 上游 key 池的数据访问（main 写，网关只读） */
@Injectable()
export class AiProviderKeyRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  list(providerId: string): Promise<AiProviderKeyEntity[]> {
    return this.db.getRepository(AiProviderKeyEntity).find({
      where: { providerId },
      order: { createdAt: 'DESC' },
    })
  }

  findById(id: string): Promise<AiProviderKeyEntity | null> {
    return this.db.getRepository(AiProviderKeyEntity).findOne({ where: { id } })
  }

  create(data: DeepPartial<AiProviderKeyEntity>): Promise<AiProviderKeyEntity> {
    const repo = this.db.getRepository(AiProviderKeyEntity)
    return repo.save(repo.create(data))
  }

  async update(
    id: string,
    data: DeepPartial<AiProviderKeyEntity>,
  ): Promise<AiProviderKeyEntity | null> {
    const repo = this.db.getRepository(AiProviderKeyEntity)
    await repo.update(id, data)
    return this.findById(id)
  }

  async softDelete(id: string): Promise<void> {
    await this.db.getRepository(AiProviderKeyEntity).softDelete(id)
  }
}
