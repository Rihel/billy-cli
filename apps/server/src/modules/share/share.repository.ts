import { Inject, Injectable } from '@nestjs/common'
import { Db } from '@repo/kits'
import { AiFileEntity } from '../../database/entities/ai-file-entity.js'
import { FileShareEntity } from '../../database/entities/file-share-entity.js'

/**
 * `file_shares` 仓储（设计 `docs/design/file-share.md` §4）。
 *
 * 文件行只读、只按 id 取 —— 分享不持有文件内容，也不改 `ai_files`。
 * `touchViewed` 用原生 `views = views + 1`：读改写会在并发访问时丢计数。
 */
@Injectable()
export class ShareRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  private repo() {
    return this.db.getRepository(FileShareEntity)
  }

  /** 目标文件（TypeORM 默认过滤软删行，删掉的分享自然查不到） */
  findFile(fileId: string): Promise<AiFileEntity | null> {
    return this.db.getRepository(AiFileEntity).findOne({ where: { id: fileId } })
  }

  async create(input: {
    tokenHash: string
    fileId: string
    createdBy: string | null
    expiresAt: Date | null
  }): Promise<FileShareEntity> {
    return this.repo().save(this.repo().create(input))
  }

  findByTokenHash(tokenHash: string): Promise<FileShareEntity | null> {
    return this.repo().findOne({ where: { tokenHash } })
  }

  findById(id: string): Promise<FileShareEntity | null> {
    return this.repo().findOne({ where: { id } })
  }

  listByFile(fileId: string): Promise<FileShareEntity[]> {
    return this.repo().find({
      where: { fileId },
      order: { createdAt: 'DESC' },
    })
  }

  /** 撤销：只写一次 `revoked_at`（幂等，已撤销的不覆盖） */
  async revoke(id: string): Promise<void> {
    await this.repo()
      .createQueryBuilder()
      .update()
      .set({ revokedAt: new Date() })
      .where('id = :id AND revoked_at IS NULL', { id })
      .execute()
  }

  /** 记一次打开（失败不影响响应，调用方忽略异常） */
  async touchViewed(id: string): Promise<void> {
    await this.repo()
      .createQueryBuilder()
      .update()
      .set({ views: () => '"views" + 1', lastViewedAt: new Date() })
      .where('id = :id', { id })
      .execute()
  }
}
