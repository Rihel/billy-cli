import { z } from 'zod'
import { BaseModel, BasePaginateDto } from './base.schema'

const TodoFields = z.object({
  title: z.string(),
  description: z.string().optional(),
  completed: z.boolean().default(false),
})

export const TodoModel = z.intersection(BaseModel, TodoFields)

export const CreateTodoDto = TodoFields.omit({ completed: true })

export const UpdateTodoDto = TodoFields.extend({
  todoId: z.string(),
})

export const PageQueryTodoDto = BasePaginateDto.extend({
  keyword: z.string().optional(),
  orderBy: z.enum(['updatedAt', 'createdAt']).optional().default('updatedAt'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
})
