import { Inject, Injectable } from '@nestjs/common'
import { Db, getAuditUser, pageWith, safeDelete, type PageQueryResult } from '@repo/kits'
import { RunStatus, type AgentConversationListDto, type AgentConversationModel } from '@repo/shared'
import { In, IsNull, type DeepPartial } from 'typeorm'
import { ConversationEntity, RunEntity } from '@repo/db'

/**
 * 实体 → 对外模型（bigint 在 TypeORM 里是字符串，这里转成 number 给前端）。
 *
 * `running` 由调用方查一下运行表给出（默认 false）：**它不是会话表上的字段** ——
 * 会话语义上是"有没有在跑的一轮"，真相在 `runs`（根 run 的 pending / running）。
 */
export const toConversationModel = (
  record: ConversationEntity,
  running = false,
): AgentConversationModel => ({
  id: record.id,
  agentKey: record.agentKey,
  ...(record.parentConversationId ? { parentConversationId: record.parentConversationId } : {}),
  ...(record.rootConversationId ? { rootConversationId: record.rootConversationId } : {}),
  kind: record.kind,
  depth: record.depth,
  title: record.title,
  status: record.status,
  fileAccess: record.fileAccess === 'read-only' ? 'read-only' : 'workspace-write',
  turnCount: record.turnCount,
  totalTokens: Number(record.totalTokens),
  running,
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

  /** 子会话幂等查：同一个父工具调用只建一次 */
  async findChildByOrigin(
    originRunId: string,
    originToolCallId: string,
  ): Promise<ConversationEntity | null> {
    const repo = await this.repo()
    return repo.findOne({ where: { originRunId, originToolCallId } })
  }

  /**
   * 创建（或复用）子 agent 的子会话。
   *
   * 工作区 / 文件归属仍是根会话；子会话只承载自己的 run / timeline / 标题。
   * 唯一键冲突（并发创建）时回读已存在的那一行，保证同一个 toolCallId 只有一条。
   */
  async ensureSubagent(input: {
    parent: ConversationEntity
    name: string
    agentKey: string
    depth: number
    originRunId: string
    originToolCallId: string | null
  }): Promise<ConversationEntity> {
    const repo = await this.repo()
    if (input.originToolCallId) {
      const existing = await this.findChildByOrigin(input.originRunId, input.originToolCallId)
      if (existing) return existing
    }
    const entity = repo.create({
      userId: input.parent.userId,
      agentKey: input.agentKey,
      title: `子助手：${input.name}`.slice(0, 200),
      fileAccess: input.parent.fileAccess,
      status: 'active',
      lastActiveAt: new Date(),
      kind: 'subagent',
      depth: input.depth,
      parentConversationId: input.parent.id,
      rootConversationId: input.parent.rootConversationId ?? input.parent.id,
      originRunId: input.originRunId,
      originToolCallId: input.originToolCallId,
    })
    try {
      return await repo.save(entity)
    } catch (error) {
      if (input.originToolCallId) {
        const existing = await this.findChildByOrigin(input.originRunId, input.originToolCallId)
        if (existing) return existing
      }
      throw error
    }
  }

  /** 某个根会话下的子会话（删除级联 / 审计用） */
  async listChildren(parentConversationId: string): Promise<ConversationEntity[]> {
    const repo = await this.repo()
    return repo.find({ where: { parentConversationId }, order: { createdAt: 'ASC' } })
  }

  /** 取实体（内部用；`withDeleted` 供审计视角查已软删的会话） */
  async findEntity(
    id: string,
    options: { withDeleted?: boolean } = {},
  ): Promise<ConversationEntity | null> {
    const repo = await this.repo()
    return repo.findOne({ where: { id }, withDeleted: options.withDeleted ?? false })
  }

  /**
   * 会话归属者 id（推流频道 `ai:owner:{id}` 用）。
   *
   * `withDeleted: true`：删会话时也要发运行态变更（先把跑着的 run 取消，再软删），
   * 若这里按软删过滤就会漏掉最后一次通知，侧栏的呼吸灯将一直亮着。
   */
  async findOwnerId(id: string): Promise<string | null> {
    const repo = await this.repo()
    const row = await repo.findOne({
      where: { id },
      select: { userId: true },
      withDeleted: true,
    })
    return row?.userId ?? null
  }

  /**
   * 某用户的会话列表（默认不含已软删；**按创建时间倒序**）。
   *
   * 为什么按创建时间：列表是"我什么时候开的会话"的索引，用户要求顺序稳定（新开的在最前，
   * 旧会话不会因为刚聊过就被顶上去）；`created_at` 不会变，分页也不会错位。
   * `last_active_at` 仍然记录，但不再参与排序。
   */
  async list(
    userId: string,
    query: AgentConversationListDto,
  ): Promise<PageQueryResult<AgentConversationModel>> {
    const { page, size, includeDeleted } = query
    const repo = await this.repo()
    const builder = repo
      .createQueryBuilder('c')
      .where('c.userId = :userId', { userId })
      // 会话列表只显示根会话；子 agent 的子会话通过父会话 / 详情入口看
      .andWhere('c.parentConversationId IS NULL')
      .orderBy('c.createdAt', 'DESC')
      .addOrderBy('c.id', 'DESC')
    if (includeDeleted) builder.withDeleted()
    const { data, total } = await pageWith(builder, page, size)
    const runningIds = await this.runningIds(data.map((record) => record.id))
    return {
      items: data.map((record) => toConversationModel(record, runningIds.has(record.id))),
      total,
      page,
      size,
    }
  }

  /**
   * 这一页里**正在跑**的会话 id（一次查询批量算，不逐条查）。
   *
   * 只看**根 run**（`parent_run_id IS NULL`）：子 agent 在跑不代表"这一轮还没结束" —— 恰恰相反，父在等它。
   * 状态用字典值（`pending` / `running`），与部分唯一索引 `uk_run_active_conversation` 同一口径。
   */
  async runningIds(conversationIds: readonly string[]): Promise<Set<string>> {
    if (conversationIds.length === 0) return new Set()
    const repo = await this.repo()
    const rows = await repo.manager.getRepository(RunEntity).find({
      where: {
        conversationId: In([...conversationIds]),
        parentRunId: IsNull(),
        status: In([RunStatus.Pending, RunStatus.Running]),
      },
      select: { conversationId: true },
    })
    return new Set(rows.map((row) => row.conversationId))
  }

  /** 单个会话是否正在跑（详情路径用） */
  async isRunning(conversationId: string): Promise<boolean> {
    return (await this.runningIds([conversationId])).has(conversationId)
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

  /**
   * 只累加 token（**不动轮数**）。
   *
   * 子 run 的消耗要走这里补记：它的用量本来由父 run 收尾时汇总，但异步子 agent 下
   * 「父收尾时子还没跑完」是常态，只靠父汇总会漏记（2026-11-15 实测漏 218 万 / 约 40%）。
   * 轮数口径不变 —— 一轮问答算一轮，子助手不额外计轮。
   */
  async addTokens(id: string, tokens: number): Promise<void> {
    const repo = await this.repo()
    await repo
      .createQueryBuilder()
      .update(ConversationEntity)
      .set({
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

  /** 改会话的文件权限（只读 / 可写）：只影响沙箱内的写权限 */
  async setFileAccess(id: string, fileAccess: 'read-only' | 'workspace-write'): Promise<void> {
    const repo = await this.repo()
    await repo.update({ id }, { fileAccess })
  }
}
