import { z } from 'zod'
import { BaseModel, BasePaginateDto } from './base.schema'

/** 后台用户（管理员）状态字典：与 UserStatus 保持一致 */
export const AdminStatusSchema = z.enum(['enabled', 'disabled'])

export const AdminSchema = BaseModel.extend({
  email: z.email(),
  realName: z.string().nullable(),
  avatar: z.string().nullable(),
  status: AdminStatusSchema,
})
export type AdminModel = z.infer<typeof AdminSchema>

export const AdminIdSchema = z.object({
  adminId: z.string(),
})

export const AdminLoginSchema = z.object({
  email: z.email(),
  password: z.string(),
})
export type AdminLoginDto = z.infer<typeof AdminLoginSchema>

/** 登录结果模型 */
export const AdminAuthResultSchema = z.object({
  token: z.string(),
  admin: AdminSchema,
})
export type AdminAuthResultModel = z.infer<typeof AdminAuthResultSchema>

export const CreateAdminSchema = z.object({
  email: z.email(),
  password: z.string().min(6),
  realName: z.string().optional(),
  avatar: z.string().nullable().optional(),
})
export type CreateAdminDto = z.infer<typeof CreateAdminSchema>

export const GetAdminDetailSchema = AdminIdSchema.extend({})
export type GetAdminDetailDto = z.infer<typeof GetAdminDetailSchema>

export const RemoveAdminSchema = AdminIdSchema.extend({})
export type RemoveAdminDto = z.infer<typeof RemoveAdminSchema>

export const UpdateAdminSchema = AdminIdSchema.extend({
  realName: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  status: AdminStatusSchema.optional(),
})
export type UpdateAdminDto = z.infer<typeof UpdateAdminSchema>

export const ResetAdminPasswordSchema = AdminIdSchema.extend({
  password: z.string().min(6),
})
export type ResetAdminPasswordDto = z.infer<typeof ResetAdminPasswordSchema>

/** 当前登录管理员更新个人信息 */
export const AdminUpdateInfoSchema = z.object({
  realName: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
})
export type AdminUpdateInfoDto = z.infer<typeof AdminUpdateInfoSchema>

export const PageQueryAdminDto = BasePaginateDto.extend({
  keyword: z.string().optional(),
  status: AdminStatusSchema.optional(),
  orderBy: z
    .enum(['createdAt', 'updatedAt', 'email'])
    .optional()
    .default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
})
export type PageQueryAdminDto = z.infer<typeof PageQueryAdminDto>
