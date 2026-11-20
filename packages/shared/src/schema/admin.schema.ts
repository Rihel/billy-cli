import { z } from 'zod'
import { AdminType } from '../dicts/admin-type.dict'
import { BaseModelSchema, BasePaginateSchema } from './base.schema'

/** 后台用户（管理员）状态字典：与 UserStatus 保持一致 */
export const AdminStatusSchema = z.enum(['enabled', 'disabled'])

/** 管理员类型（取值来自字典：单一事实源，加一级角色只改字典） */
export const AdminTypeSchema = z.enum(AdminType.values as unknown as [string, ...string[]])

export const AdminSchema = BaseModelSchema.extend({
  email: z.email(),
  realName: z.string().nullable(),
  avatar: z.string().nullable(),
  status: AdminStatusSchema,
  /**
   * 管理员类型：`normal` / `god`（见 `AdminType` 字典）。
   *
   * 实体属性与会话负载里同名（`adminType` 之外的叫法会与 JWT 的 token 类型 `type` 混淆），
   * 只有 `god` 能改这个字段，普通管理员改一律拒绝。
   */
  type: AdminTypeSchema,
})
export type AdminModel = z.infer<typeof AdminSchema>

/** id 入参基类（单条记录定位，如 detail / remove / update / reset-password） */
export const AdminIdInputSchema = z.object({
  adminId: z.string(),
})
export type AdminIdInputDto = z.infer<typeof AdminIdInputSchema>

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
  /** 只在超管调用时允许传 `god`；普通管理员传了会被服务层拒绝（不是静默忽略） */
  type: AdminTypeSchema.optional(),
})
export type CreateAdminDto = z.infer<typeof CreateAdminSchema>

export const GetAdminDetailSchema = AdminIdInputSchema.extend({})
export type GetAdminDetailDto = z.infer<typeof GetAdminDetailSchema>

export const RemoveAdminSchema = AdminIdInputSchema.extend({})
export type RemoveAdminDto = z.infer<typeof RemoveAdminSchema>

export const UpdateAdminSchema = AdminIdInputSchema.extend({
  realName: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  status: AdminStatusSchema.optional(),
  /** 只有超管能改；降级最后一个超管会被拒绝 */
  type: AdminTypeSchema.optional(),
})
export type UpdateAdminDto = z.infer<typeof UpdateAdminSchema>

export const ResetAdminPasswordSchema = AdminIdInputSchema.extend({
  password: z.string().min(6),
})
export type ResetAdminPasswordDto = z.infer<typeof ResetAdminPasswordSchema>

/** 当前登录管理员更新个人信息 */
export const AdminUpdateInfoSchema = z.object({
  realName: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
})
export type AdminUpdateInfoDto = z.infer<typeof AdminUpdateInfoSchema>

export const PageQueryAdminSchema = BasePaginateSchema.extend({
  keyword: z.string().optional(),
  status: AdminStatusSchema.optional(),
  orderBy: z.enum(['createdAt', 'updatedAt', 'email']).optional().default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
})
export type PageQueryAdminDto = z.infer<typeof PageQueryAdminSchema>
