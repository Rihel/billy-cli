import { AuditEntity } from '@repo/kits'
import { ConversationStatus } from '@repo/shared'
import { Column, Entity, Index } from 'typeorm'

/**
 * 会话（一个对话窗口）。
 *
 * 一行 = 一个用户和某个 agent 的一串问答；会话可归档、可软删（**只能软删**，见设计文档 §4.5）。
 * 冗余 `turn_count` / `total_tokens` 是为了会话列表不需要聚合 `runs`。
 */
@Entity('conversations')
@Index('idx_conversation_user_created', ['userId', 'createdAt'])
@Index('idx_conversation_parent_created', ['parentConversationId', 'createdAt'])
/** 子会话幂等：同一个父 run 的同一个工具调用只建一次子会话 */
@Index('uk_conversation_origin', ['originRunId', 'originToolCallId'], {
  unique: true,
  where: "kind = 'subagent' AND origin_run_id IS NOT NULL AND origin_tool_call_id IS NOT NULL",
})
export class ConversationEntity extends AuditEntity {
  /** 归属用户（服务端从鉴权上下文取，绝不接受前端传） */
  @Column({ name: 'user_id', type: 'varchar', length: 20 })
  userId!: string

  /** 创建时用的 agent（会话可换，以每次运行为准，见 RunEntity.agentKey） */
  @Column({ name: 'agent_key', type: 'varchar', length: 64 })
  agentKey!: string

  /**
   * 父会话（`null` = 根会话）。
   *
   * 子 agent 现在是**子会话**：有自己的 run / timeline / 标题，工作区仍指向根会话。
   */
  @Column({ name: 'parent_conversation_id', type: 'varchar', length: 20, nullable: true })
  parentConversationId: string | null = null

  /**
   * 根会话 id（工作区 / 文件归属）。
   *
   * 根会话迁移时回填成自身 id；新根会话为 null 时调用方回落成 `id`。
   */
  @Column({ name: 'root_conversation_id', type: 'varchar', length: 20, nullable: true })
  rootConversationId: string | null = null

  /** 根会话 / 子会话 */
  @Column({ name: 'kind', type: 'varchar', length: 16, default: 'root' })
  kind: 'root' | 'subagent' = 'root'

  /** 子会话深度（根 0，子 1） */
  @Column({ name: 'depth', type: 'int', default: 0 })
  depth = 0

  /** 子会话来源：父 run */
  @Column({ name: 'origin_run_id', type: 'varchar', length: 20, nullable: true })
  originRunId: string | null = null

  /** 子会话来源：父 run 里的工具调用（幂等键） */
  @Column({ name: 'origin_tool_call_id', type: 'varchar', length: 64, nullable: true })
  originToolCallId: string | null = null

  /** 会话标题（首条消息摘要 / 模型生成 / 用户改） */
  @Column({ name: 'title', type: 'text', default: '' })
  title = ''

  /**
   * 本会话的**文件权限**：`workspace-write`（默认）/ `read-only`。
   *
   * 只决定"沙箱内能不能写工作区"；能不能出沙箱是部署配置（`AGENT_WORKSPACE_MODE`），
   * 用户选不到（web 产品的安全底线，见 `docs/design/workspace-runtime.md`）。
   */
  @Column({ name: 'file_access', type: 'varchar', length: 16, default: 'workspace-write' })
  fileAccess: 'read-only' | 'workspace-write' = 'workspace-write'

  /** 状态：见 ConversationStatus 字典（active / archived） */
  @Column({ name: 'status', type: 'varchar', length: 20, default: ConversationStatus.Active })
  status: string = ConversationStatus.Active

  /**
   * 最后活动时间（**只是记录**，不参与列表排序）。
   *
   * 列表按 `created_at` 排序（用户口径：会话列表要稳定地按创建先后排，不能因为"谁刚用过"
   * 就跳来跳去；分页也不会因为活动时间变化而错位）。这一列保留给统计 / 运维排查用。
   */
  @Column({ name: 'last_active_at', type: 'timestamp', precision: 3 })
  lastActiveAt!: Date

  /** 轮数（一次问答算一轮），由运行收尾时原子累加 */
  @Column({ name: 'turn_count', type: 'int', default: 0 })
  turnCount = 0

  /** 累计 token，由运行收尾时原子累加（bigint 在 TypeORM 里按字符串读写） */
  @Column({ name: 'total_tokens', type: 'bigint', default: 0 })
  totalTokens: string = '0'

  /** 扩展位（Mastra 的 thread.metadata 等原样保留） */
  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null = null
}
