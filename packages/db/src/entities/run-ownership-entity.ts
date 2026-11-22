import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm'

/**
 * durable run 的所有权租约（Mastra run fencing 的存储）。
 *
 * 一张表只做一件事：给某个 engine runId 记录「当前执行者 + generation + 租约到期时间」。
 * `generation` 每次被重新 claim 时 +1，旧执行者带着旧 generation 的写入会被存储层拒绝，
 * 用来兜住「恢复租约过期 / 多副本同时恢复」时的双写。
 *
 * 不继承 BaseEntity：主键是 runId（engine runId），不需要 nanoid / 软删。
 */
@Entity('run_ownership')
export class RunOwnershipEntity {
  /** engine runId（`runs.engine_run_id`） */
  @PrimaryColumn({ name: 'run_id', type: 'varchar', length: 64 })
  runId!: string

  /** 当前持有者（执行实例 id） */
  @Column({ name: 'owner_id', type: 'varchar', length: 128 })
  ownerId!: string

  /** claim 代数：新 claim 必须大于旧 claim；bigint 由 pg 返回字符串 */
  @Column({ name: 'generation', type: 'bigint' })
  generation!: string

  /** 租约到期时间；null = 已主动 release（允许重新 claim，旧持有者的写入仍可接受） */
  @Column({ name: 'lease_expires_at', type: 'timestamp', precision: 3, nullable: true })
  leaseExpiresAt!: Date | null

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp', precision: 3 })
  updatedAt!: Date
}
