import { Column, Entity, Index } from 'typeorm'
import { BaseEntity } from '@repo/kits'
import { UserStatus } from '@repo/shared'

/**
 * 邮箱在**活动用户**内唯一（部分唯一索引）。
 *
 * 为什么不是 `UNIQUE(email, deleted_at)`：PostgreSQL 里 NULL 互不相等，软删行 `deleted_at`
 * 非空能约束到，但**活动行（deleted_at IS NULL）之间不冲突** —— 同一邮箱可以注册多个活用户。
 * 部分唯一索引只把「未删除」的行纳入唯一性判断，语义才是想要的。
 */
@Entity('users')
@Index('uk_user_email', ['email'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
export class UserEntity extends BaseEntity {
  @Column({ name: 'email', type: 'text' })
  email!: string

  @Column({ name: 'password', type: 'text' })
  password!: string

  @Column({ name: 'real_name', type: 'text', nullable: true })
  realName: string | null = null

  @Column({ name: 'avatar', type: 'text', nullable: true })
  avatar: string | null = null

  @Column({ name: 'reset_password_token', type: 'text', nullable: true })
  resetPasswordToken: string | null = null

  @Column({
    name: 'reset_password_token_expiry',
    type: 'timestamp',
    precision: 3,
    nullable: true,
  })
  resetPasswordTokenExpiry: Date | null = null

  @Column({
    name: 'status',
    type: 'varchar',
    default: UserStatus.Enabled,
    length: 20,
    comment: '用户状态',
  })
  status!: string
}
