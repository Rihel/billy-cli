import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

/**
 * **初始化清单**（`docs/design/workspace-cli-credentials.md` §6.2）。
 *
 * 装好的 CLI 不属于资产；「需要哪些 CLI、什么版本、配了什么」属于资产。
 * 后者作为声明存储，前者由声明在工作区里重放生成。
 *
 * 归属规则：**用户一份默认清单 + 工作区追加**。默认清单保证新工作区零准备可用，
 * 工作区追加项（`ai_workspaces.setup_extra`）只对该工作区生效。
 *
 * 安全口径：清单在每次重建时于模型执行前运行，**等价于持久化代码执行**；
 * 因此只允许在管理端编辑，模型只能建议（编辑接口随管理页落地）。
 */
@Entity('ai_workspace_setups')
@Index('uk_workspace_setup_name', ['ownerType', 'ownerId', 'name'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
@Index('idx_workspace_setup_owner', ['ownerType', 'ownerId'])
export class AiWorkspaceSetupEntity extends BaseEntity {
  /** 归属主体：`admin` / `user` */
  @Column({ name: 'owner_type', type: 'varchar', length: 8 })
  ownerType!: string

  @Column({ name: 'owner_id', type: 'varchar', length: 20 })
  ownerId!: string

  /** 清单名：`default` 是每个主体的默认清单（工作区不指定时用它） */
  @Column({ name: 'name', type: 'varchar', length: 64 })
  name!: string

  /** 安装项：[{ manager, spec, verify, cli? }]（结构见 `WorkspaceSetupPackageSchema`） */
  @Column({ name: 'packages', type: 'jsonb', default: () => "'[]'" })
  packages: unknown[] = []

  /** 非凭据配置文件（{ path, content }[]） */
  @Column({ name: 'files', type: 'jsonb', default: () => "'[]'" })
  files: unknown[] = []

  /** 非敏感环境变量（凭据类走 `personal_credentials` 的注入规则） */
  @Column({ name: 'env', type: 'jsonb', default: () => "'{}'" })
  env: Record<string, unknown> = {}

  /** `active` / `disabled`（整体禁用是清单的兜底开关） */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'active' })
  status = 'active'
}
