import { Column, Entity, PrimaryColumn, Unique } from 'typeorm'
import { BaseEntity } from '@repo/kits'
import { UserStatus } from '@repo/shared'

@Entity('users')
@Unique('uk_user_email', ['email', 'deletedAt'])
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
