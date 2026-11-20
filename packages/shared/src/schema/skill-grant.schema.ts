import { z } from 'zod'
import { BaseModelSchema } from './base.schema'

/**
 * 技能授权（`docs/design/workspace-cli-credentials.md` §6.7.2）。
 *
 * 平台技能默认不对外开放，需要显式授予；个人技能不走授权表（仅 owner 可见）。
 * `principal_type='all'` 表示对所有人开放（`principal_id` 固定 `*`）。
 */
export const SkillGrantPrincipalTypeSchema = z.enum(['user', 'admin', 'all'])

export const SkillGrantSchema = BaseModelSchema.extend({
  skillKey: z.string(),
  principalType: SkillGrantPrincipalTypeSchema,
  principalId: z.string(),
  grantedBy: z.string().nullable(),
})
export type SkillGrantModel = z.infer<typeof SkillGrantSchema>

export const SkillGrantPrincipalSchema = z
  .object({
    principalType: SkillGrantPrincipalTypeSchema,
    principalId: z.string().min(1).max(20),
  })
  .refine(
    (value) => value.principalType !== 'all' || value.principalId === '*',
    '对所有人开放时 principalId 固定为 *',
  )
export type SkillGrantPrincipal = z.infer<typeof SkillGrantPrincipalSchema>

export const SkillGrantListSchema = z.object({
  skillKey: z.string().min(1).max(64),
})
export type SkillGrantListDto = z.infer<typeof SkillGrantListSchema>

/** 覆盖式设置：传进来的就是最终可见主体集合 */
export const SkillGrantSetSchema = z.object({
  skillKey: z.string().min(1).max(64),
  principals: z.array(SkillGrantPrincipalSchema).max(200),
})
export type SkillGrantSetDto = z.infer<typeof SkillGrantSetSchema>
