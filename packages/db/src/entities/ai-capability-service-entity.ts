import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

/**
 * 能力服务登记快照（**网关的事实源**）。
 *
 * 一行 = 一个服务，`snapshot` 是完整的 `RegisteredService`（能力清单 / 实例 / 探活 / 版本）。
 * 为什么用整条 JSONB 而不是拆列：登记契约还在演进（protocol / inputSchema / 内建能力…），
 * 拆列会让每次加字段都动迁移；快照形态下契约加字段是兼容变更（旧行 `safeParse` 补默认值）。
 *
 * 写方只有网关（`ServiceRegistry.persist`）；Redis 只做运行时快照（多副本共享 + 重启加速），
 * **DB 才是事实源**——Redis 丢了目录仍然在。出站凭据不落这张表（单独存，见网关的 `credentials`）。
 */
@Entity('ai_capability_services')
@Index('uk_capability_service', ['service'], { unique: true })
export class AiCapabilityServiceEntity extends BaseEntity {
  /** 服务名（全局唯一） */
  @Column({ name: 'service', type: 'varchar', length: 24 })
  service!: string

  /** 整条 `RegisteredService` 快照 */
  @Column({ name: 'snapshot', type: 'jsonb' })
  snapshot!: Record<string, unknown>
}
