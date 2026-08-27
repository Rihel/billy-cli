import { Column, Entity, Unique } from 'typeorm'
import { BaseEntity } from '@repo/kits'
import { UserStatus } from '@repo/shared'

@Entity('admins')
@Unique('uk_admin_email', ['email', 'deletedAt'])
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
