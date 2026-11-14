import { Column, Entity, Index } from 'typeorm'
import { BaseEntity } from '@repo/kits'
import { UserStatus } from '@repo/shared'

/** 同 `users`：邮箱在**活动管理员**内唯一，软删行不参与唯一性判断 */
@Entity('admins')
@Index('uk_admin_email', ['email'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
export class AdminEntity extends BaseEntity {
  @Column({ name: 'email', type: 'text' })
  email!: string

  @Column({ name: 'password', type: 'text' })
  password!: string

  @Column({ name: 'real_name', type: 'text', nullable: true })
  realName: string | null = null

  @Column({ name: 'avatar', type: 'text', nullable: true })
  avatar: string | null = null

  @Column({
    name: 'status',
    type: 'varchar',
    length: 20,
    default: UserStatus.Enabled,
  })
  status!: string
}
