import { Effect } from 'effect'
import { TodoRepository } from '../capabilities/todo.repository.js'
import type { TodoCursorQuery } from '../domain.js'

export const cursorTodos = (query: TodoCursorQuery) =>
  Effect.gen(function* () {
    const repository = yield* TodoRepository
    return yield* repository.cursor(query)
  })
