import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

/**
 * 工作空间（AI 执行环境）的**配置与用户意图**。
 *
 * 方案 B 的写方边界（见 `docs/design/workspace.md` §7）：
 * - **main 是唯一写方**：配置、`desired_status`、软删；
 * - **workspace-service 只读**：按 id 取配置去起容器 / 执行，运行态不写回本表。
 *
 * `desired_status` 只表达用户「启动 / 停止」的意图；容器实际是否在跑由执行面实时返回。
 * 2 小时 idle 回收是实际状态变化，**不回写这里**（下次执行 `ensure` 重新拉起）。
 */
@Entity('ai_workspaces')
@Index('uk_workspace_default', ['ownerType', 'ownerId'], {
  unique: true,
  where: `"is_default" = true AND "deleted_at" IS NULL`,
})
@Index('idx_workspace_owner', ['ownerType', 'ownerId'])
export class AiWorkspaceEntity extends BaseEntity {
  /** 归属主体：当前只有 `admin`（AI 会话只在后台端使用）；用户端开放后加 `user` */
  @Column({ name: 'owner_type', type: 'varchar', length: 8, default: 'admin' })
  ownerType = 'admin'

  /** 主体 id（逻辑引用，无物理外键） */
  @Column({ name: 'owner_id', type: 'varchar', length: 20 })
  ownerId!: string

  @Column({ name: 'name', type: 'varchar', length: 64 })
  name!: string

  /** 每个主体恰好一条默认工作区（部分唯一索引钉住） */
  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault = false

  /** 执行后端：`local`（自托管，走 L1 沙箱）/ `container`（云端，Docker）/ `microvm`（预留） */
  @Column({ name: 'backend', type: 'varchar', length: 16, default: 'container' })
  backend = 'container'

  /** 容器镜像（`container` 必填，形如 `billy-workspace:2026.11.0`） */
  @Column({ name: 'image', type: 'varchar', length: 128, nullable: true })
  image: string | null = null

  /** backend 相关配置：local 的 root / container 的 workdir 等 */
  @Column({ name: 'location', type: 'jsonb', nullable: true })
  location: Record<string, unknown> | null = null

  /** 文件权限：`read-only` / `write` */
  @Column({ name: 'file_access', type: 'varchar', length: 16, default: 'write' })
  fileAccess = 'write'

  /** 用户意图：`running` / `stopped`（不是实际运行态） */
  @Column({ name: 'desired_status', type: 'varchar', length: 16, default: 'stopped' })
  desiredStatus = 'stopped'

  /**
   * 初始化清单引用（`ai_workspace_setups.id`）。
   *
   * 空值 = 使用 owner 的 `default` 清单；`setupExtra` 是本工作区追加的安装项，
   * 两者合并后才进入初始化阶段。
   */
  @Column({ name: 'setup_id', type: 'varchar', length: 20, nullable: true })
  setupId: string | null = null

  /** 本工作区追加的安装项（结构同清单的 `packages`） */
  @Column({ name: 'setup_extra', type: 'jsonb', default: () => "'[]'" })
  setupExtra: unknown[] = []

  /** 最后使用时间（main 在会话绑定时更新；执行面不写） */
  @Column({ name: 'last_used_at', type: 'timestamp', precision: 3, nullable: true })
  lastUsedAt: Date | null = null
}
