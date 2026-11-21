import { Inject, Injectable } from '@nestjs/common'
import { AiFileEntity, ConversationEntity, RunEntity } from '@repo/db'
import { Db, getAuditUser, pageWith, safeDelete, type PageQueryResult } from '@repo/kits'
import {
  RunStatus,
  type AgentConversationListDto,
  type AgentConversationModel,
  type AgentFileModel,
  type AgentFileNode,
  buildFileTree,
} from '@repo/shared'
import { In, IsNull, type DeepPartial } from 'typeorm'

/**
 * 实体 → 对外模型（bigint 在 TypeORM 里是字符串，这里转成 number 给前端）。
 *
 * `running` 不是会话表上的字段（真相在 `runs`），由调用方批量算好传进来。
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
  workspaceId: record.workspaceId ?? null,
  status: record.status,
  fileAccess: record.fileAccess === 'read-only' ? 'read-only' : 'workspace-write',
  turnCount: record.turnCount,
  totalTokens: Number(record.totalTokens),
  running,
  lastActiveAt: record.lastActiveAt,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
})

/** `ai_files` 一行的对外投影（文件树节点里的 `file`） */
const toFileModel = (record: AiFileEntity): AgentFileModel => ({
  id: record.id,
  path: record.path,
  source: record.source === 'user' ? 'user' : 'ai',
  filename: record.filename,
  key: record.key,
  bytes: record.bytes,
  mediaType: record.mediaType,
  sha256: record.sha256,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
})

/**
 * 会话查询 / 写入的仓储（**只碰 conversations + 它自己的 ai_files**）。
 *
 * 与运行 / 时间线仓储分开：三者粒度不同（会话是一串问答、运行是一次执行、时间线是一件事），
 * 混在一个仓储里迟早会为了各自的查询条件互相将就。
 */
@Injectable()
export class AiConversationRepository {
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

  /** 某个根会话下的子会话（删除级联用） */
  async listChildren(parentConversationId: string): Promise<ConversationEntity[]> {
    const repo = await this.repo()
    return repo.find({ where: { parentConversationId }, order: { createdAt: 'ASC' } })
  }

  /**
   * 某身份的会话列表（默认不含已软删；**按创建时间倒序**）。
   *
   * 与既有口径一致：只列根会话（子 agent 的子会话从父会话 / 详情入口看），
   * `created_at` 不随使用变化，分页不会错位。
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
   * 只看根 run（`parent_run_id IS NULL`）：子 agent 在跑不代表这一轮没结束 —— 父在等它。
   */
  async runningIds(conversationIds: readonly string[]): Promise<Set<string>> {
    if (conversationIds.length === 0) return new Set()
    const repo = this.db.getRepository(RunEntity)
    const rows = await repo.find({
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

  /** 会话详情里的文件树（用户上传 + AI 提交；与 `ai_files` 同一份数据） */
  async listFileTree(conversationId: string): Promise<AgentFileNode[]> {
    const repo = this.db.getRepository(AiFileEntity)
    const rows = await repo.find({
      where: { conversationId },
      order: { path: 'ASC' },
    })
    return buildFileTree(rows.map(toFileModel))
  }

  /**
   * 软删（写 deleted_by + deleted_at；运行记录与时间线一律保留）。
   *
   * 用 kits 的纯函数 `safeDelete`：类型上要求实体带审计列，于是"没有审计列的实体想软删"
   * 会在编译期报错；操作人取请求上下文（无上下文回落 system）。
   */
  async softDelete(id: string): Promise<void> {
    await safeDelete(this.db.dataSource.manager, ConversationEntity, { id }, getAuditUser())
  }

  /**
   * 软删会话文件行（**不删对象**）。
   *
   * 与既有口径的差异：对象存储与工作区清理属于文件管理侧的职责，不在本模块的查询 CRUD 里；
   * 这里只保证会话删掉后文件列表不再列出它们。
   */
  async softDeleteFiles(conversationId: string): Promise<void> {
    const repo = this.db.getRepository(AiFileEntity)
    await repo.softDelete({ conversationId })
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
