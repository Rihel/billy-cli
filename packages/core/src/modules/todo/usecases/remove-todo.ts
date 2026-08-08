import { Effect } from 'effect'
import { ApplicationLogger } from '../../../shared/application-logger.capability.js'
import { TodoNotFoundError } from '../errors.js'
import { TodoRepository } from '../capabilities/todo.repository.js'
import type { TodoId } from '../domain.js'

export const removeTodo = ({ todoId }: TodoId) =>
  Effect.gen(function* () {
    const repository = yield* TodoRepository
    const applicationLogger = yield* ApplicationLogger
    const todo = yield* repository.remove(todoId)
    if (!todo) return yield* new TodoNotFoundError({ todoId })
    yield* Effect.sync(() =>
      applicationLogger.log('todo.removed', { id: todoId }),
    )
    return todo
  })
