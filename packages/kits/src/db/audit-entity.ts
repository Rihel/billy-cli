import { Column } from 'typeorm'
import { BaseEntity } from './base-entity.js'

/**
 * 带操作人审计字段的实体基类（可选）。
 *
 * 需要审计的业务实体继承本类（而非 BaseEntity），并把 {@link AuditSubscriber}
 * 注册进 Db 配置的 `subscribers`，即可自动记录创建 / 更新 / 软删操作人。
 *
 * 注意：新增了 3 个列，需生成并执行迁移；不需要审计的实体继续用 BaseEntity 即可。
 */
export abstract class AuditEntity extends BaseEntity {
  /** 创建人 id（无请求上下文时为 'system'） */
  @Column({ name: 'created_by', type: 'varchar', length: 64, nullable: true })
  createdBy!: string | null

  /** 最后更新人 id */
  @Column({ name: 'updated_by', type: 'varchar', length: 64, nullable: true })
  updatedBy!: string | null

  /** 软删操作人 id */
  @Column({ name: 'deleted_by', type: 'varchar', length: 64, nullable: true })
  deletedBy!: string | null
}
