import { z } from 'zod'
import { BasePaginateDto } from './base.schema'

export const UserIdInputDto = z.object({
  userId: z.string(),
})

export const CreateUserDto = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  realName: z.string().optional(),
  avatar: z.string().nullable().optional(),
})

export const GetUserDetailDto = UserIdInputDto.extend({})

export const RemoveUserDto = UserIdInputDto.extend({})

export const UpdateUserDto = UserIdInputDto.extend({
  realName: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
})

export const ResetUserPasswordDto = UserIdInputDto.extend({
  password: z.string().min(6),
})

export const PageQueryUserDto = BasePaginateDto.extend({
  keyword: z.string().optional(),
  orderBy: z
    .enum(['createdAt', 'updatedAt', 'email'])
    .optional()
    .default('createdAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
})
