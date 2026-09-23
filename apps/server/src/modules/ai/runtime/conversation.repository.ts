import { Inject, Injectable } from '@nestjs/common'
import { Db, getAuditUser, pageWith, safeDelete, type PageQueryResult } from '@repo/kits'
import type { AgentConversationListDto, AgentConversationModel } from '@repo/shared'
import type { DeepPartial } from 'typeorm'
import { ConversationEntity } from '../../../database/entities/conversation-entity.js'

/** 实体 → 对外模型（bigint 在 TypeORM 里是字符串，这里转成 number 给前端） */
export const toConversationModel = (record: ConversationEntity): AgentConversationModel => ({
  id: record.id,
  agentKey: record.agentKey,
  title: record.title,
  status: record.status,
  turnCount: record.turnCount,
  totalTokens: Number(record.totalTokens),
  lastActiveAt: record.lastActiveAt,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
})

@Injectable()
export class ConversationRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async repo() {
    return this.db.getRepository(ConversationEntity)
  }

  async create(data: DeepPartial<ConversationEntity>): Promise<AgentConversationModel> {
    const repo = await this.repo()
    return toConversationModel(await repo.save(repo.create(data)))
  }

  /** 取实体（内部用；`withDeleted` 供审计视角查已软删的会话） */
  async findEntity(
    id: string,
    options: { withDeleted?: boolean } = {},
  ): Promise<ConversationEntity | null> {
    const repo = await this.repo()
    return repo.findOne({ where: { id }, withDeleted: options.withDeleted ?? false })
  }

  /** 某用户的会话列表（默认不含已软删；按最后活动时间倒序） */
  async list(
    userId: string,
    query: AgentConversationListDto,
  ): Promise<PageQueryResult<AgentConversationModel>> {
    const { page, size, includeDeleted } = query
    const repo = await this.repo()
    const builder = repo
      .createQueryBuilder('c')
      .where('c.userId = :userId', { userId })
      .orderBy('c.lastActiveAt', 'DESC')
      .addOrderBy('c.id', 'DESC')
    if (includeDeleted) builder.withDeleted()
    const { data, total } = await pageWith(builder, page, size)
    return { items: data.map(toConversationModel), total, page, size }
  }

  /**
   * 软删（写 deleted_by + deleted_at；运行记录与时间线一律保留）。
   *
   * 用 kits 的纯函数 `safeDelete`：它类型上要求实体继承 `AuditEntity`，
   * 于是"没有审计列的实体想软删"会在编译期报错；操作人取请求上下文（无上下文回落 system）。
   */
  async softDelete(id: string): Promise<void> {
    await safeDelete(this.db.dataSource.manager, ConversationEntity, { id }, getAuditUser())
  }

  /**
   * 收尾时的会话累计：轮数 +1、token 累加、刷新最后活动时间。
   *
   * **必须用 SQL 内累加**（不能读出来加完再写）：同一会话可能有并发请求，
   * 读改写会丢更新。
   */
  async accumulate(id: string, tokens: number): Promise<void> {
    const repo = await this.repo()
    await repo
      .createQueryBuilder()
      .update(ConversationEntity)
      .set({
        turnCount: () => 'turn_count + 1',
        totalTokens: () => 'total_tokens + :tokens',
        lastActiveAt: () => 'now()',
      })
      .where('id = :id', { id })
      .setParameter('tokens', tokens)
      .execute()
  }

  /** 设置标题（首条消息生成，或用户改名） */
  async setTitle(id: string, title: string): Promise<void> {
    const repo = await this.repo()
    await repo.update({ id }, { title })
  }
}
