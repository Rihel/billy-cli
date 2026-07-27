import { z } from 'zod'

/** 日期时间字段：接受 string 或 Date，JSON 序列化时 Date 自动转为 ISO 字符串 */
const dateField = z.union([z.string(), z.date()])

export const BaseModel = z.object({
  createdAt: dateField,
  updatedAt: dateField,
  id: z.string(),
})

export const BasePaginateDto = z.object({
  page: z.number().int().min(1).optional().default(1),
  size: z.number().int().min(1).max(100).optional().default(10),
})

export const BaseCursorPaginateDto = z.object({
  size: z.number().int().min(1).max(100).optional().default(20),
})
