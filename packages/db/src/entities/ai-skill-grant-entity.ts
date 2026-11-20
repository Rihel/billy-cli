import { BaseEntity } from '@repo/kits'
import { Column, Entity, Index } from 'typeorm'

/**
 * **技能授权**（`docs/design/workspace-cli-credentials.md` §6.7.2）。
 *
 * 平台技能默认不对外开放，需要显式授予；个人技能不走这张表（仅 owner 可见）。
 * `principal_type='all'` 用于「对所有人开放」，避免按用户逐条插入。
 */
@Entity('ai_skill_grants')
@Index('uk_skill_grant', ['skillKey', 'principalType', 'principalId'], {
  unique: true,
  where: 'deleted_at IS NULL',
})
@Index('idx_skill_grant_principal', ['principalType', 'principalId'])
export class AiSkillGrantEntity extends BaseEntity {
  @Column({ name: 'skill_key', type: 'varchar', length: 64 })
  skillKey!: string

  /** `user` / `admin` / `all`（all 时 principalId 固定 `*`） */
  @Column({ name: 'principal_type', type: 'varchar', length: 8 })
  principalType!: string

  @Column({ name: 'principal_id', type: 'varchar', length: 20 })
  principalId!: string

  @Column({ name: 'granted_by', type: 'varchar', length: 20, nullable: true })
  grantedBy: string | null = null
}
