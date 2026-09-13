import { z } from 'zod'
import {
  BaseCursorPaginateSchema,
  BaseModelSchema,
  BasePaginateSchema,
} from './base.schema'

const TodoFields = z.object({
  title: z.string(),
  description: z.string().nullable().optional(),
  completed: z.boolean().default(false),
})

export const TodoSchema = z.intersection(BaseModelSchema, TodoFields)

export type TodoModel = z.infer<typeof TodoSchema>

/** id 入参基类（单条记录定位，如 detail / remove / update） */
export const TodoIdInputSchema = z.object({
  todoId: z.string(),
})
export type TodoIdInputDto = z.infer<typeof TodoIdInputSchema>

export const GetDetailTodoSchema = TodoIdInputSchema.extend({})
export type GetDetailTodoDto = z.infer<typeof GetDetailTodoSchema>

export const RemoveTodoSchema = TodoIdInputSchema.extend({})
export type RemoveTodoDto = z.infer<typeof RemoveTodoSchema>

export const CreateTodoSchema = TodoFields.omit({ completed: true })
export type CreateTodoDto = z.infer<typeof CreateTodoSchema>

export const UpdateTodoSchema = z.intersection(TodoIdInputSchema, TodoFields)
export type UpdateTodoDto = z.infer<typeof UpdateTodoSchema>

export const PageQueryTodoSchema = BasePaginateSchema.extend({
  keyword: z.string().optional(),
  orderBy: z.enum(['updatedAt', 'createdAt']).optional().default('updatedAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
})

export type PageQueryTodoDto = z.infer<typeof PageQueryTodoSchema>

export const TodoCursorSchema = z.object({
  updatedAt: z.iso.datetime(),
  todoId: z.string(),
})

/** 游标模型（响应） */
export type TodoCursorModel = z.infer<typeof TodoCursorSchema>

export const CursorQueryTodoSchema = BaseCursorPaginateSchema.extend({
  cursor: TodoCursorSchema.optional(),
  keyword: z.string().optional(),
})

export type CursorQueryTodoDto = z.infer<typeof CursorQueryTodoSchema>
