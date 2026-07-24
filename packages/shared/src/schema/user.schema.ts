import { z } from 'zod'
import { BasePaginateDto } from './base.schema'

export const CreateUserDto = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  realName: z.string().optional(),
})

export const UpdateUserDto = z.object({
  userId: z.string(),
  realName: z.string().nullable().optional(),
})

export const ResetUserPasswordDto = z.object({
  userId: z.string(),
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
