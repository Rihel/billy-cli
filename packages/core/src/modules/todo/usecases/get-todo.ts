import { Effect } from 'effect'
import { TodoNotFoundError } from '../errors.js'
import { TodoRepository } from '../capabilities/todo.repository.js'
import type { TodoId } from '../domain.js'

export const getTodo = ({ todoId }: TodoId) =>
  Effect.gen(function* () {
    const repository = yield* TodoRepository
    const todo = yield* repository.findById(todoId)
    if (!todo) return yield* new TodoNotFoundError({ todoId })
    return todo
  })
