import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

/**
 * **凭据审计**（`docs/design/workspace-cli-credentials.md` §6.4.8）。
 *
 * 每一次读取、刷新、导入、吊销与拒绝都留痕，且**记录中不含凭据值**。
 *
 * 三条口径：
 * - **独立成表而不是塞进主表**：审计是追加写，混入主表会让热行持续膨胀、拖慢每次解析；
 * - **`deny` 事件可能没有 `credential_id`**（缺凭据 / 越权 / 吊销后仍尝试使用），
 *   所以这一列可空，但事件本身必须落下来；
 * - **只追加，不提供删除接口**；保留期与归档策略另行确定。
 */
@Entity('personal_credential_audits')
@Index('idx_credential_audit_credential', ['credentialId', 'createdAt'])
@Index('idx_credential_audit_owner', ['ownerType', 'ownerId', 'createdAt'])
export class PersonalCredentialAuditEntity extends BaseEntity {
  /** 关联的凭据（拒绝类事件可能没有对应记录） */
  @Column({ name: 'credential_id', type: 'varchar', length: 20, nullable: true })
  credentialId: string | null = null

  @Column({ name: 'owner_type', type: 'varchar', length: 8 })
  ownerType!: string

  @Column({ name: 'owner_id', type: 'varchar', length: 20 })
  ownerId!: string

  /** `issue` / `refresh` / `revoke` / `import` / `resolve` / `deny`（见 `CredentialAuditAction`） */
  @Column({ name: 'action', type: 'varchar', length: 16 })
  action!: string

  /** `workspace-service` / `capability-gateway` / `web` / `main` */
  @Column({ name: 'consumer', type: 'varchar', length: 32 })
  consumer!: string

  /** 关联到具体那次执行（由调用方传入，便于和工具日志对齐） */
  @Column({ name: 'request_id', type: 'varchar', length: 64, nullable: true })
  requestId: string | null = null

  /** 失败原因等附加信息，**绝不含凭据值** */
  @Column({ name: 'detail', type: 'jsonb', default: () => "'{}'" })
  detail: Record<string, unknown> = {}
}
