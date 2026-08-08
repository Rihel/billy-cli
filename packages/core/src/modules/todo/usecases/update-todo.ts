import { Effect } from 'effect'
import { ApplicationLogger } from '../../../shared/application-logger.capability.js'
import { TodoNotFoundError } from '../errors.js'
import { TodoRepository } from '../capabilities/todo.repository.js'
import type { UpdateTodo } from '../domain.js'

export const updateTodo = ({ todoId, ...changes }: UpdateTodo) =>
  Effect.gen(function* () {
    const repository = yield* TodoRepository
    const applicationLogger = yield* ApplicationLogger
    const todo = yield* repository.update(todoId, changes)
    if (!todo) return yield* new TodoNotFoundError({ todoId })
    yield* Effect.sync(() =>
      applicationLogger.log('todo.updated', { id: todoId }),
    )
    return todo
  })
