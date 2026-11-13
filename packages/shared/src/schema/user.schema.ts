import { z } from 'zod'
import { BaseModelSchema, BasePaginateSchema } from './base.schema'

/** 用户状态：与 UserStatus 字典保持一致 */
export const UserStatusSchema = z.enum(['enabled', 'disabled'])

export const UserSchema = BaseModelSchema.extend({
  email: z.email(),
  realName: z.string().nullable(),
  avatar: z.string().nullable(),
  status: UserStatusSchema,
})
export type UserModel = z.infer<typeof UserSchema>

/** id 入参基类（单条记录定位，如 detail / remove / update / reset-password） */
export const UserIdInputSchema = z.object({
  userId: z.string(),
})
export type UserIdInputDto = z.infer<typeof UserIdInputSchema>

export const CreateUserSchema = z.object({
  email: z.email(),
  password: z.string().min(6),
  realName: z.string().optional(),
  avatar: z.string().nullable().optional(),
  status: UserStatusSchema.optional(),
})
export type CreateUserDto = z.infer<typeof CreateUserSchema>

export const GetUserDetailSchema = UserIdInputSchema.extend({})
export type GetUserDetailDto = z.infer<typeof GetUserDetailSchema>

export const RemoveUserSchema = UserIdInputSchema.extend({})
export type RemoveUserDto = z.infer<typeof RemoveUserSchema>

export const RemoveUserResultSchema = z.object({
  success: z.literal(true),
})
export type RemoveUserResultModel = z.infer<typeof RemoveUserResultSchema>

export const UpdateUserSchema = UserIdInputSchema.extend({
  realName: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  status: UserStatusSchema.optional(),
})
export type UpdateUserDto = z.infer<typeof UpdateUserSchema>

export const ResetUserPasswordSchema = UserIdInputSchema.extend({
  password: z.string().min(6),
})
export type ResetUserPasswordDto = z.infer<typeof ResetUserPasswordSchema>

export const PageQueryUserSchema = BasePaginateSchema.extend({
  keyword: z.string().optional(),
  status: UserStatusSchema.optional(),
  orderBy: z.enum(['createdAt', 'updatedAt', 'email']).optional().default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
})
export type PageQueryUserDto = z.infer<typeof PageQueryUserSchema>
