import { Effect } from 'effect'
import { ApplicationLogger } from '../../../shared/application-logger.capability.js'
import { TodoRepository } from '../capabilities/todo.repository.js'
import type { CreateTodo } from '../domain.js'

export const createTodo = (input: CreateTodo) =>
  Effect.gen(function* () {
    const repository = yield* TodoRepository
    const applicationLogger = yield* ApplicationLogger
    const todo = yield* repository.create(input)
    yield* Effect.sync(() =>
      applicationLogger.log('todo.created', { id: todo.id }),
    )
    return todo
  })
