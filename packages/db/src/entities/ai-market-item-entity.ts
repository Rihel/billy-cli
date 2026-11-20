import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

/**
 * **AI 市场条目**（`docs/design/workspace-cli-credentials.md` §6.9）。
 *
 * 市场是统一分发入口，按类型分发，但**归属与权限分叉**：
 * - `mcp` → 平台资产、管理员收录（v1 只做这一区）；
 * - `cli` / `skill` → 个人资产，随用户端开放。
 *
 * 注意：市场不是白名单 —— 未收录的 CLI 同样可以在初始化清单里声明。
 */
@Entity('ai_market_items')
@Index('uk_market_key', ['key'], { unique: true, where: 'deleted_at IS NULL' })
@Index('idx_market_type', ['type', 'scope'])
export class AiMarketItemEntity extends BaseEntity {
  @Column({ name: 'key', type: 'varchar', length: 64 })
  key!: string

  @Column({ name: 'name', type: 'varchar', length: 64 })
  name!: string

  @Column({ name: 'description', type: 'text', nullable: true })
  description: string | null = null

  @Column({ name: 'category', type: 'varchar', length: 32, nullable: true })
  category: string | null = null

  /** `mcp` / `cli` / `skill` */
  @Column({ name: 'type', type: 'varchar', length: 8 })
  type!: string

  /** `platform` / `personal`（mcp 固定 platform） */
  @Column({ name: 'scope', type: 'varchar', length: 8 })
  scope!: string

  /** 安装 / 登记所需的数据（MCP 条目记录能力服务 key 等） */
  @Column({ name: 'payload', type: 'jsonb', default: () => "'{}'" })
  payload: Record<string, unknown> = {}

  @Column({ name: 'icon', type: 'varchar', length: 255, nullable: true })
  icon: string | null = null
}
