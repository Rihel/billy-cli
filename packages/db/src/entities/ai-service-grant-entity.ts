import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

/**
 * 服务级授权（**管理员 × 外部服务/MCP**）。
 *
 * 只对 `source='manual'` 的服务生效；`source='code'` 的自建协议服务默认全部可用，不写这里。
 * 存服务名而不是内部 id：服务名是协议级稳定标识（工具 key / 审计 / 配置都用它）。
 * `principal_type` 现在固定 `admin`，预留给后续的用户 / 角色授权。
 */
@Entity('ai_service_grants')
@Index('uk_service_grant', ['principalType', 'principalId', 'service'], { unique: true })
@Index('idx_service_grant_principal', ['principalType', 'principalId'])
@Index('idx_service_grant_service', ['service'])
export class AiServiceGrantEntity extends BaseEntity {
  @Column({ name: 'principal_type', type: 'varchar', length: 8, default: 'admin' })
  principalType = 'admin'

  @Column({ name: 'principal_id', type: 'varchar', length: 20 })
  principalId!: string

  @Column({ name: 'service', type: 'varchar', length: 64 })
  service!: string

  @Column({ name: 'granted_by', type: 'varchar', length: 20, nullable: true })
  grantedBy: string | null = null
}
