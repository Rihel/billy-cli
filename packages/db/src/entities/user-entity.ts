import { Column, Entity, PrimaryColumn } from 'typeorm'
import { BaseEntity } from './base-entity'

@Entity('users')
export class UserEntity extends BaseEntity {
  @Column({ name: 'email', type: 'text', unique: true })
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
}
