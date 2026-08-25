import { z } from 'zod'
import { BaseModel, BasePaginateDto } from './base.schema'

export const UserSchema = BaseModel.extend({
  email: z.email(),
  realName: z.string().nullable(),
  avatar: z.string().nullable(),
})

export type UserModel = z.infer<typeof UserSchema>

export const UserIdSchema = z.object({
  userId: z.string(),
})

export const CreateUserSchema = z.object({
  email: z.email(),
  password: z.string().min(6),
  realName: z.string().optional(),
  avatar: z.string().nullable().optional(),
})
export type CreateUserDto = z.infer<typeof CreateUserSchema>

export const GetUserDetailSchema = UserIdSchema.extend({})
export type GetUserDetailDto = z.infer<typeof GetUserDetailSchema>

export const RemoveUserSchema = UserIdSchema.extend({})
export type RemoveUserDto = z.infer<typeof RemoveUserSchema>

export const RemoveUserResultSchema = z.object({
  success: z.literal(true),
})
export type RemoveUserResultModel = z.infer<typeof RemoveUserResultSchema>

export const UpdateUserSchema = UserIdSchema.extend({
  realName: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
})
export type UpdateUserDto = z.infer<typeof UpdateUserSchema>

export const ResetUserPasswordSchema = UserIdSchema.extend({
  password: z.string().min(6),
})
export type ResetUserPasswordDto = z.infer<typeof ResetUserPasswordSchema>

export const PageQueryUserDto = BasePaginateDto.extend({
  keyword: z.string().optional(),
  orderBy: z
    .enum(['createdAt', 'updatedAt', 'email'])
    .optional()
    .default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
})
export type PageQueryUserDto = z.infer<typeof PageQueryUserDto>
