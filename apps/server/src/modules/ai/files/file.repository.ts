import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import {
  nanoid,
  type AgentFileAdminItem,
  type AgentFileAdminListDto,
  type AgentFileAdminListModel,
  type AgentFileAdminQueryDto,
  type AgentFileAdminStatsModel,
  type AgentFileModel,
} from '@repo/shared'
import { AiFileEntity } from '../../../database/entities/ai-file-entity.js'
import { ConversationEntity } from '../../../database/entities/conversation-entity.js'

/**
 * `ai_files` 仓储（设计 §3）。
 *
 * 所有写都经过**原生 upsert**：TypeORM 的软删默认过滤会把已删行排除在查询外，
 * 而 `(conversation_id, path)` 唯一键在软删后仍然占位；用 `ON CONFLICT ... DO UPDATE`
 * 才能把 `deleted_at` 置回 null。
 */
@Injectable()
export class FileRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private repo() {
    return this.db.getRepository(AiFileEntity)
  }

  async find(conversationId: string, path: string): Promise<AiFileEntity | null> {
    return this.repo().findOne({ where: { conversationId, path } })
  }

  async findById(id: string): Promise<AiFileEntity | null> {
    return this.repo().findOne({ where: { id } })
  }

  async list(conversationId: string): Promise<AiFileEntity[]> {
    return this.repo().find({
      where: { conversationId },
      order: { updatedAt: 'DESC' },
    })
  }

  async listAllWithDeleted(conversationId: string): Promise<AiFileEntity[]> {
    return this.repo().find({
      where: { conversationId },
      withDeleted: true,
    })
  }

  async countAndBytes(
    conversationId: string,
    excludePath?: string,
  ): Promise<{ count: number; bytes: number }> {
    const builder = this.repo()
      .createQueryBuilder('f')
      .select('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(f.bytes), 0)', 'bytes')
      .where('f.conversationId = :conversationId', { conversationId })
    if (excludePath) {
      builder.andWhere('f.path <> :excludePath', { excludePath })
    }
    const row = await builder.getRawOne<{ count: string; bytes: string }>()
    return {
      count: Number(row?.count ?? 0),
      bytes: Number(row?.bytes ?? 0),
    }
  }

  /**
   * 按 `(conversation_id, path)` upsert；返回落库后的行。
   *
   * `deleted_at` 必须显式置 null：同一路径重新提交 / 重新收到附件时要“复活”旧行。
   */
  async upsert(data: {
    conversationId: string
    source: string
    path: string
    filename: string
    key: string
    mediaType: string
    bytes: number
    sha256: string | null
    userId: string | null
    runId: string | null
    toolCallId: string | null
  }): Promise<AiFileEntity> {
    const id = nanoid()
    await this.repo().query(
      `INSERT INTO ai_files
        (id, conversation_id, source, path, filename, key, media_type, bytes, sha256, user_id, run_id, tool_call_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (conversation_id, path) DO UPDATE SET
         source = EXCLUDED.source,
         filename = EXCLUDED.filename,
         key = EXCLUDED.key,
         media_type = EXCLUDED.media_type,
         bytes = EXCLUDED.bytes,
         sha256 = EXCLUDED.sha256,
         user_id = EXCLUDED.user_id,
         run_id = EXCLUDED.run_id,
         tool_call_id = EXCLUDED.tool_call_id,
         deleted_at = NULL,
         updated_at = now()`,
      [
        id,
        data.conversationId,
        data.source,
        data.path,
        data.filename,
        data.key,
        data.mediaType,
        data.bytes,
        data.sha256,
        data.userId,
        data.runId,
        data.toolCallId,
      ],
    )
    const saved = await this.find(data.conversationId, data.path)
    if (!saved) throw new Error(`ai_files upsert 后找不到 ${data.conversationId}/${data.path}`)
    return saved
  }

  async softDeleteByConversation(conversationId: string): Promise<void> {
    await this.repo()
      .createQueryBuilder()
      .softDelete()
      .where('conversation_id = :conversationId', { conversationId })
      .execute()
  }

  /** 后台文件页的公共筛选：文件名 / 会话标题 + 创建时间范围 */
  private adminQuery(input: AgentFileAdminQueryDto) {
    const builder = this.repo()
      .createQueryBuilder('f')
      .leftJoin(ConversationEntity, 'c', 'c.id = f.conversation_id')
      .where('f.deleted_at IS NULL')

    const keyword = input.keyword?.trim()
    if (keyword) {
      builder.andWhere('(f.filename ILIKE :keyword OR c.title ILIKE :keyword)', {
        keyword: `%${keyword}%`,
      })
    }
    if (input.from) {
      builder.andWhere('f.created_at >= :from', { from: new Date(`${input.from}T00:00:00`) })
    }
    if (input.to) {
      builder.andWhere('f.created_at <= :to', { to: new Date(`${input.to}T23:59:59.999`) })
    }
    return builder
  }

  /** 管理员全量列表：文件 + 所属会话标题；支持按大小 / 时间排序 */
  async adminList(input: AgentFileAdminListDto): Promise<AgentFileAdminListModel> {
    const base = this.adminQuery(input)
    const total = await base.clone().getCount()
    const sortColumn =
      input.sortBy === 'size'
        ? 'f.bytes'
        : input.sortBy === 'updatedAt'
          ? 'f.updated_at'
          : 'f.created_at'
    const rows = await base
      .select([
        'f.id AS id',
        'f.conversation_id AS "conversationId"',
        'c.title AS "conversationTitle"',
        'f.filename AS filename',
        'f.path AS path',
        'f.key AS key',
        'f.source AS source',
        'f.media_type AS "mediaType"',
        'f.bytes AS bytes',
        'f.created_at AS "createdAt"',
        'f.updated_at AS "updatedAt"',
      ])
      .orderBy(sortColumn, input.sortOrder === 'asc' ? 'ASC' : 'DESC')
      .addOrderBy('f.id', 'DESC')
      .offset((input.page - 1) * input.size)
      .limit(input.size)
      .getRawMany<Record<string, unknown>>()

    const items: AgentFileAdminItem[] = rows.map((row) => ({
      id: String(row.id),
      conversationId: String(row.conversationId),
      conversationTitle: String(row.conversationTitle ?? ''),
      filename: String(row.filename),
      path: String(row.path),
      key: String(row.key),
      source: row.source === 'user' ? 'user' : 'ai',
      mediaType: String(row.mediaType),
      bytes: Number(row.bytes ?? 0),
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    }))
    return { items, total, page: input.page, size: input.size }
  }

  /** 管理员总量统计：总数 / 总字节 / 用户与 AI 拆分 / 涉及会话数 */
  async adminStats(input: AgentFileAdminQueryDto): Promise<AgentFileAdminStatsModel> {
    const row = await this.adminQuery(input)
      .select([
        'COUNT(*) AS count',
        'COALESCE(SUM(f.bytes), 0) AS bytes',
        "COALESCE(SUM(CASE WHEN f.source = 'user' THEN 1 ELSE 0 END), 0) AS \"userCount\"",
        "COALESCE(SUM(CASE WHEN f.source = 'user' THEN f.bytes ELSE 0 END), 0) AS \"userBytes\"",
        "COALESCE(SUM(CASE WHEN f.source = 'ai' THEN 1 ELSE 0 END), 0) AS \"aiCount\"",
        "COALESCE(SUM(CASE WHEN f.source = 'ai' THEN f.bytes ELSE 0 END), 0) AS \"aiBytes\"",
        'COUNT(DISTINCT f.conversation_id) AS "conversationCount"',
      ])
      .getRawOne<Record<string, unknown>>()
    return {
      count: Number(row?.count ?? 0),
      bytes: Number(row?.bytes ?? 0),
      userCount: Number(row?.userCount ?? 0),
      userBytes: Number(row?.userBytes ?? 0),
      aiCount: Number(row?.aiCount ?? 0),
      aiBytes: Number(row?.aiBytes ?? 0),
      conversationCount: Number(row?.conversationCount ?? 0),
    }
  }

  /** 行 → 对外模型（不含字节） */
  toModel(record: AiFileEntity): AgentFileModel {
    return {
      path: record.path,
      source: record.source === 'user' ? 'user' : 'ai',
      filename: record.filename,
      key: record.key,
      bytes: record.bytes,
      mediaType: record.mediaType,
      sha256: record.sha256,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }
}
