import { z } from 'zod'

/** 日期时间字段：接受 string 或 Date，JSON 序列化时 Date 自动转为 ISO 字符串 */
const dateField = z.union([z.string(), z.date()]).optional()

/**
 * 契约基类：只作 `extend` / `intersection` 的基石，不导出类型
 * （它们不是可直接使用的入参 / 响应；具体契约各自在同一文件导出 `XxxDto` / `XxxModel`）。
 */
export const BaseModelSchema = z.object({
  createdAt: dateField,
  updatedAt: dateField,
  id: z.string(),
})

/** 页码分页入参基类（配合 `PageQueryResult`） */
export const BasePaginateSchema = z.object({
  page: z.number().int().min(1).optional().default(1),
  size: z.number().int().min(1).max(100).optional().default(10),
})

/** 游标分页入参基类（配合自定义 cursor 模型） */
export const BaseCursorPaginateSchema = z.object({
  size: z.number().int().min(1).max(100).optional().default(20),
})
