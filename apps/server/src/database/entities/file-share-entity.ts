import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

/**
 * **文件分享**（`file_shares`，设计 `docs/design/file-share.md` §4）。
 *
 * 一行 = 一条免授权分享链接。五条口径：
 * - **只存 token 的哈希**：明文只在创建响应里出现一次，拖库拿不到可用链接；
 * - **不存状态列**：`active / expired / revoked / invalid` 由 `expires_at` / `revoked_at`
 *   与文件行派生（见 `shareState`），避免「状态说有效、其实早过期」的二义性；
 * - **`expires_at` 可空**：null = 永久；档位换算在 shared 的 `shareTtlSeconds`；
 * - **逻辑引用 `ai_files.id`**：无物理外键（全工程硬规则），文件被软删时链接自动失效；
 * - **`views` 只在 `meta` 命中时自增**：内容接口会因 Range 发多次请求，按它计数会虚高。
 *
 * `token_hash` 走唯一索引：校验链路就是「算哈希 → 查一行」，不需要额外签名。
 */
@Entity('file_shares')
@Index('uk_file_share_token', ['tokenHash'], { unique: true })
@Index('idx_file_share_file', ['fileId', 'createdAt'])
@Index('idx_file_share_expires', ['expiresAt'])
export class FileShareEntity extends BaseEntity {
  /** `sha256(token)` 十六进制；明文从不落库 */
  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash!: string

  /** 指向 `ai_files.id`（逻辑引用） */
  @Column({ name: 'file_id', type: 'varchar', length: 20 })
  fileId!: string

  /** 创建人（管理员或前台用户 id）；鉴权关闭时为 null */
  @Column({ name: 'created_by', type: 'varchar', length: 20, nullable: true })
  createdBy: string | null = null

  /** 过期时间；null = 永久 */
  @Column({ name: 'expires_at', type: 'timestamp', precision: 3, nullable: true })
  expiresAt: Date | null = null

  /** 撤销时间；非空即失效 */
  @Column({ name: 'revoked_at', type: 'timestamp', precision: 3, nullable: true })
  revokedAt: Date | null = null

  /** 被打开次数（meta 命中自增） */
  @Column({ name: 'views', type: 'int', default: 0 })
  views = 0

  /** 最后一次打开时间 */
  @Column({ name: 'last_viewed_at', type: 'timestamp', precision: 3, nullable: true })
  lastViewedAt: Date | null = null
}
