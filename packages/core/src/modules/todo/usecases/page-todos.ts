import { Effect } from 'effect'
import { TodoRepository } from '../capabilities/todo.repository.js'
import type { TodoPageQuery } from '../domain.js'

export const pageTodos = (query: TodoPageQuery) =>
  Effect.gen(function* () {
    const repository = yield* TodoRepository
    return yield* repository.page(query)
  })
