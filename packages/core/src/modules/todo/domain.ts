import { Data } from 'effect'

export class Todo extends Data.Class<{
  id: string
  title: string
  description: string | null
  completed: boolean
  createdAt: Date
  updatedAt: Date
}> {}

export class CreateTodo extends Data.Class<{
  title: string
  description?: string | null
}> {}

export class UpdateTodo extends Data.Class<{
  todoId: string
  title: string
  description?: string | null
  completed?: boolean
}> {}

export class TodoId extends Data.Class<{ todoId: string }> {}

export class TodoPageQuery extends Data.Class<{
  page: number
  size: number
  keyword?: string
  orderBy?: 'updatedAt' | 'createdAt'
  order?: 'asc' | 'desc'
}> {}

export class TodoCursor extends Data.Class<{
  updatedAt: string
  todoId: string
}> {}

export class TodoCursorQuery extends Data.Class<{
  size: number
  cursor?: TodoCursor
  keyword?: string
}> {}
