import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import type {
  MarketItemKeyDto,
  MarketItemListDto,
  MarketItemModel,
  MarketItemSaveDto,
} from '@repo/shared'
import { MarketRepository } from './market.repository.js'
import { MarketItemNotFoundError } from './market.errors.js'

/**
 * AI 市场（v1 只做 MCP 区，§6.9）。
 *
 * 市场只准备"声明"，不装二进制、不启容器：
 * MCP 条目 = 平台资产，由管理员收录（指向能力网关里的服务）。
 */
@Injectable()
export class MarketService {
  constructor(
    @Inject(MarketRepository) private readonly repo: MarketRepository,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async list(input: MarketItemListDto): Promise<MarketItemModel[]> {
    const rows = await this.repo.list(input)
    return rows.map(toModel)
  }

  /** 收录 / 更新（MCP 条目 scope 固定 platform） */
  async save(input: MarketItemSaveDto): Promise<MarketItemModel> {
    const row = await this.repo.upsert({
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      category: input.category ?? null,
      type: input.type,
      scope: 'platform',
      payload: input.payload,
      icon: input.icon ?? null,
    })
    this.logger.log('market.item_saved', { key: row.key, type: row.type })
    return toModel(row)
  }

  async remove(input: MarketItemKeyDto): Promise<{ removed: boolean }> {
    const removed = await this.repo.softRemove(input.key)
    if (!removed) throw new MarketItemNotFoundError(input.key)
    this.logger.log('market.item_removed', { key: input.key })
    return { removed }
  }
}

const toModel = (row: {
  key: string
  name: string
  description: string | null
  category: string | null
  type: string
  scope: string
  payload: Record<string, unknown>
  icon: string | null
  id: string
  createdAt: Date
  updatedAt: Date
}): MarketItemModel => ({
  id: row.id,
  key: row.key,
  name: row.name,
  description: row.description,
  category: row.category,
  type: row.type as MarketItemModel['type'],
  scope: row.scope as MarketItemModel['scope'],
  payload: row.payload,
  icon: row.icon,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})
