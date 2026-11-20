import { Column, Entity, Index } from 'typeorm'
import { BaseEntity } from '@repo/kits'
import { AdminType, DEFAULT_ADMIN_TYPE, UserStatus } from '@repo/shared'

/** 同 `users`：邮箱在**活动管理员**内唯一，软删行不参与唯一性判断 */
@Entity('admins')
@Index('uk_admin_email', ['email'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
@Index('idx_admin_type', ['type'])
export class AdminEntity extends BaseEntity {
  @Column({ name: 'email', type: 'text' })
  email!: string

  @Column({ name: 'password', type: 'text' })
  password!: string

  /**
   * 管理员类型（`normal` / `god`，见 `AdminType` 字典）。
   *
   * 默认 `normal`：迁移后既有管理员一律是普通管理员，超管由种子服务
   * （`GOD_ADMIN_EMAIL` / `GOD_ADMIN_PASSWORD`）或运维脚本显式升级，
   * **迁移里不写死任何账号**（邮箱密码无法跨环境复用）。
   */
  @Column({ name: 'type', type: 'varchar', length: 8, default: DEFAULT_ADMIN_TYPE })
  type: string = AdminType.Normal

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
