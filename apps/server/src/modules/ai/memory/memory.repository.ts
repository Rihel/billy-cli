import { Inject, Injectable } from '@nestjs/common'
import { Db, pageWith, type PageQueryResult } from '@repo/kits'
import type { AiMemoryListDto } from '@repo/shared'
import { In, IsNull } from 'typeorm'
import { AiMemoryEntity } from '../../../database/entities/ai-memory-entity.js'

/**
 * 长期记忆的数据访问层（设计 `docs/design/ai-memory.md` §5）。
 *
 * 只做读写与过滤，不含业务判断（上限、去重编排在 service）。
 * 三条口径：
 * - **所有面向用户的查询强制带 `user_id`**（后台列表除外，它由管理员鉴权兜底）；
 * - 软删由 `softDelete` 完成，TypeORM 默认查询自动排除；
 * - 注入只取「启用 + 未过期 + 属于该用户 / 全 agent 或当前 agent」的条目。
 */
@Injectable()
export class MemoryRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private repo() {
    return this.db.dataSource.getRepository(AiMemoryEntity)
  }

  /**
   * 每轮注入用的候选：置顶 > 最近使用 > 最近更新。
   *
   * `agent_key` 的语义是**收窄**：`null` 表示该用户所有 agent 共享，非空则只给该 agent。
   */
  async listForInjection(
    userId: string,
    agentKey: string,
    limit: number,
  ): Promise<AiMemoryEntity[]> {
    return this.repo()
      .createQueryBuilder('m')
      .where('m.user_id = :userId', { userId })
      .andWhere('(m.agent_key IS NULL OR m.agent_key = :agentKey)', { agentKey })
      .andWhere('m.enabled = true')
      .andWhere('(m.expires_at IS NULL OR m.expires_at > :now)', { now: new Date() })
      .orderBy('m.pinned', 'DESC')
      .addOrderBy('m.last_used_at', 'DESC', 'NULLS LAST')
      .addOrderBy('m.updated_at', 'DESC')
      .limit(limit)
      .getMany()
  }

  /** 工具检索：只在自己的、启用的、未过期的记忆里按内容模糊匹配 */
  async search(
    userId: string,
    agentKey: string,
    keyword: string,
    limit: number,
  ): Promise<AiMemoryEntity[]> {
    return this.repo()
      .createQueryBuilder('m')
      .where('m.user_id = :userId', { userId })
      .andWhere('(m.agent_key IS NULL OR m.agent_key = :agentKey)', { agentKey })
      .andWhere('m.enabled = true')
      .andWhere('(m.expires_at IS NULL OR m.expires_at > :now)', { now: new Date() })
      .andWhere('m.content ILIKE :keyword', { keyword: `%${keyword}%` })
      .orderBy('m.pinned', 'DESC')
      .addOrderBy('m.updated_at', 'DESC')
      .limit(limit)
      .getMany()
  }

  /** 后台列表（管理员可见全部用户；按更新时间倒序） */
  async page(query: AiMemoryListDto): Promise<PageQueryResult<AiMemoryEntity>> {
    const builder = this.repo()
      .createQueryBuilder('m')
      .orderBy('m.updated_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
    if (query.userId) builder.andWhere('m.user_id = :userId', { userId: query.userId })
    if (query.kind) builder.andWhere('m.kind = :kind', { kind: query.kind })
    if (query.source) builder.andWhere('m.source = :source', { source: query.source })
    if (query.enabled !== undefined)
      builder.andWhere('m.enabled = :enabled', { enabled: query.enabled })
    if (query.keyword)
      builder.andWhere('m.content ILIKE :keyword', { keyword: `%${query.keyword}%` })
    const { data, total } = await pageWith(builder, query.page, query.size)
    return { items: data, total, page: query.page, size: query.size }
  }

  async findById(id: string): Promise<AiMemoryEntity | null> {
    return this.repo().findOneBy({ id })
  }

  /** 归属校验：用户只能碰自己的记忆（不匹配按"不存在"处理，避免探测） */
  async findOwned(id: string, userId: string): Promise<AiMemoryEntity | null> {
    return this.repo().findOneBy({ id, userId })
  }

  async findByKey(
    userId: string,
    agentKey: string | null,
    memKey: string,
  ): Promise<AiMemoryEntity | null> {
    return this.repo().findOneBy({
      userId,
      agentKey: agentKey === null ? IsNull() : agentKey,
      memKey,
    })
  }

  async countForUser(userId: string): Promise<number> {
    return this.repo().countBy({ userId })
  }

  async create(entity: Partial<AiMemoryEntity>): Promise<AiMemoryEntity> {
    return this.repo().save(this.repo().create(entity))
  }

  async update(id: string, patch: Partial<AiMemoryEntity>): Promise<void> {
    await this.repo().update({ id }, patch as never)
  }

  async softRemove(id: string): Promise<void> {
    await this.repo().softDelete({ id })
  }

  /** 批量记一次"被注入"（幂等失败只记日志，由调用方兜） */
  async touch(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    const now = new Date()
    await this.repo()
      .createQueryBuilder()
      .update(AiMemoryEntity)
      .set({ lastUsedAt: now, useCount: () => 'use_count + 1' })
      .where({ id: In([...ids]) })
      .execute()
  }
}
