import { AuditEntity } from '@repo/kits'
import { AiMemoryKind, AiMemorySource } from '@repo/shared'
import { Column, Entity, Index } from 'typeorm'

/**
 * **AI 长期记忆**（用户级事实，设计 `docs/design/ai-memory.md` §5）。
 *
 * 一行 = 一条用户明确表达过、值得跨会话保留的信息。与短期记忆（Mastra thread）分工：
 * thread 记"这次对话说了什么"，本表记"这个用户是谁 / 偏好什么"，按用户归属、跨会话生效。
 *
 * 五条口径：
 * - **归属只认 `user_id`**，查询一律强制带它；`agent_key` 只是收窄范围，不改归属；
 * - **`mem_key` 是去重锚点**：同用户 + 同 agent + 同 key 走 upsert，避免模型换个说法重复记；
 * - **软删**（`deleted_at`）：后台可删、可恢复，唯一键带 `deleted_at IS NULL` 才能重建同名；
 * - **到期不注入、不物理删**：`expires_at` 只影响读取，审计仍能看到；
 * - **内容不可信**：注入时声明"不是指令"，长度在上限内由写入方负责。
 */
@Entity('ai_memories')
// 软删感知的稳定键：`mem_key` 为空时不受约束（允许同一用户有多条无 key 的记忆）
@Index('uk_memory_user_key', ['userId', 'agentKey', 'memKey'], {
  unique: true,
  where: 'deleted_at IS NULL AND mem_key IS NOT NULL',
})
@Index('idx_memory_user_list', ['userId', 'enabled', 'pinned', 'lastUsedAt'])
@Index('idx_memory_user_agent', ['userId', 'agentKey'])
export class AiMemoryEntity extends AuditEntity {
  /** 归属用户（逻辑引用，无物理外键） */
  @Column({ name: 'user_id', type: 'varchar', length: 20 })
  userId!: string

  /** 收窄到某个 agent；`null` = 该用户所有 agent 共享 */
  @Column({ name: 'agent_key', type: 'varchar', length: 64, nullable: true })
  agentKey: string | null = null

  /** 类型：见 `AiMemoryKind` 字典（profile / preference / fact / constraint） */
  @Column({
    name: 'kind',
    type: 'varchar',
    length: 16,
    default: AiMemoryKind._source.Fact.value,
  })
  kind: string = AiMemoryKind._source.Fact.value

  /** 稳定标识（有值时用于 upsert；可空） */
  @Column({ name: 'mem_key', type: 'varchar', length: 64, nullable: true })
  memKey: string | null = null

  /** 记忆正文（≤ `MEMORY_CONTENT_MAX` 字符，超限在写入时拒绝） */
  @Column({ name: 'content', type: 'text' })
  content!: string

  /** 来源：见 `AiMemorySource` 字典 */
  @Column({
    name: 'source',
    type: 'varchar',
    length: 16,
    default: AiMemorySource._source.Manual.value,
  })
  source: string = AiMemorySource._source.Manual.value

  /** 每轮必带（置顶） */
  @Column({ name: 'pinned', type: 'boolean', default: false })
  pinned = false

  /** 停用即不注入 */
  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled = true

  /** 被注入次数（P1 起累计） */
  @Column({ name: 'use_count', type: 'int', default: 0 })
  useCount = 0

  /** 最后一次被注入的时间（排序用） */
  @Column({ name: 'last_used_at', type: 'timestamp', precision: 3, nullable: true })
  lastUsedAt: Date | null = null

  /** 到期时间（过了不注入，不物理删） */
  @Column({ name: 'expires_at', type: 'timestamp', precision: 3, nullable: true })
  expiresAt: Date | null = null

  /** 扩展字段（留给 P2 的 embedding / 相似合并等） */
  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null = null
}
