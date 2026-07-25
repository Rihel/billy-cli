import { z } from 'zod'

export const BaseModel = z.object({
  createdAt: z.string(),
  updatedAt: z.string(),
  id: z.string(),
})

export const BasePaginateDto = z.object({
  page: z.number().int().min(1).optional().default(1),
  size: z.number().int().min(1).max(100).optional().default(10),
})

export const BaseCursorPaginateDto = z.object({
  size: z.number().int().min(1).max(100).optional().default(20),
})
