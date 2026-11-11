import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

/**
 * **会话文件**（`ai_files`，设计 `docs/design/ai-file-manager.md` §3）。
 *
 * 一行 = 一个会话内文件（用户上传的入站附件，或 AI 通过 `file-submit` 提交的产出）。
 *
 * 六条口径：
 * - **`(conversation_id, path)` 唯一**：`path` 是会话内业务主键（入站 `uploads/{md5}{ext}`、
 *   AI `{fileKey}`），`id` 只给 UI key 与审计引用；
 * - **二进制只在对象存储**：本表只存元数据；`timelines.payload` 也绝不存字节；
 * - **`source` 区分生命周期**：`user` 的对象是内容寻址、可能跨会话共享，删会话只软删行、
 *   不删对象；`ai` 的对象属于本会话，删会话时删对象；
 * - **`sha256` 可空**：入站 key 自带 md5，不需要再读一遍算 sha256；AI 产出必有；
 * - **`filename` 只用于展示**（入站原始名 / AI 的 `path` 最后一段）；`path` 才是身份；
 * - **软删**：会话删除 / 文件撤回置 `deleted_at`，行保留（与 runs / timelines 的审计口径一致）。
 */
@Entity('ai_files')
@Index('uk_ai_file_path', ['conversationId', 'path'], { unique: true })
@Index('idx_ai_file_conversation', ['conversationId', 'updatedAt'])
@Index('idx_ai_file_source', ['conversationId', 'source'])
export class AiFileEntity extends BaseEntity {
  /** 所属会话（逻辑引用，无物理外键） */
  @Column({ name: 'conversation_id', type: 'varchar', length: 20 })
  conversationId!: string

  /** 来源：见 `FileSource` 字典（user / ai） */
  @Column({ name: 'source', type: 'varchar', length: 8, default: 'ai' })
  source: string = 'ai'

  /** 会话内逻辑路径：入站 `uploads/{md5}{ext}`，AI `{fileKey}` */
  @Column({ name: 'path', type: 'varchar', length: 255 })
  path!: string

  /** 展示名：入站原始文件名，AI 取 path 最后一段 */
  @Column({ name: 'filename', type: 'varchar', length: 255 })
  filename!: string

  /** 对象存储完整 key（入站引用附件已有 key，AI 由服务端拼） */
  @Column({ name: 'key', type: 'varchar', length: 512 })
  key!: string

  /** 媒体类型（服务端按后缀推断，不信模型自述） */
  @Column({ name: 'media_type', type: 'varchar', length: 128 })
  mediaType!: string

  /** 字节数（单文件上限 5MB，int 足够） */
  @Column({ name: 'bytes', type: 'int', default: 0 })
  bytes = 0

  /** 内容哈希：AI 产出必有；入站可空（key 自带 md5） */
  @Column({ name: 'sha256', type: 'varchar', length: 64, nullable: true })
  sha256: string | null = null

  /** 上传者 / 提交者（管理员 / 无身份为 null） */
  @Column({ name: 'user_id', type: 'varchar', length: 20, nullable: true })
  userId: string | null = null

  /** 入站 = 收到附件的那一轮；AI = 提交的那一轮 */
  @Column({ name: 'run_id', type: 'varchar', length: 20, nullable: true })
  runId: string | null = null

  /** 仅 AI 有：提交它的工具调用 id；入站为 null */
  @Column({ name: 'tool_call_id', type: 'varchar', length: 64, nullable: true })
  toolCallId: string | null = null
}
