import { z } from 'zod'
import {
  BaseCursorPaginateDto,
  BaseModel,
  BasePaginateDto,
} from './base.schema'

const TodoFields = z.object({
  title: z.string(),
  description: z.string().optional(),
  completed: z.boolean().default(false),
})

export const TodoModel = z.intersection(BaseModel, TodoFields)

export const TodoIdInputDto = z.object({
  todoId: z.string(),
})

export const CreateTodoDto = TodoFields.omit({ completed: true })

export const UpdateTodoDto = TodoFields.extend(TodoIdInputDto.shape)

export const PageQueryTodoDto = BasePaginateDto.extend({
  keyword: z.string().optional(),
  orderBy: z.enum(['updatedAt', 'createdAt']).optional().default('updatedAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
})

export const TodoCursorDto = z.object({
  updatedAt: z.string().datetime(),
  todoId: z.string(),
})

export const CursorQueryTodoDto = BaseCursorPaginateDto.extend({
  cursor: TodoCursorDto.optional(),
  keyword: z.string().optional(),
})
