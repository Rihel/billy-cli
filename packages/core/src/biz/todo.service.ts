import { Context, Effect, Layer } from 'effect'
import { todos } from '@repo/db'
import {
  AppErrorCodes,
  CreateTodoDto,
  CursorQueryTodoDto,
  GetDetailTodoDto,
  PageQueryTodoDto,
  RemoveTodoDto,
  UpdateTodoDto,
} from '@repo/shared'
import { eq, ilike } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { z } from 'zod'
import { AppError, makeError } from '../errors.js'
import { DbService } from '../infra/db.service.js'
import { LoggerService } from '../infra/logger.service.js'

export interface ITodoService {
  create(
    input: z.infer<typeof CreateTodoDto>,
  ): Effect.Effect<typeof todos.$inferSelect, AppError>
  pageQuery(
    input: z.infer<typeof PageQueryTodoDto>,
  ): Effect.Effect<any, AppError>
  cursorQuery(
    input: z.infer<typeof CursorQueryTodoDto>,
  ): Effect.Effect<any, AppError>
  detail(
    input: z.infer<typeof GetDetailTodoDto>,
  ): Effect.Effect<typeof todos.$inferSelect, AppError>
  update(
    input: z.infer<typeof UpdateTodoDto>,
  ): Effect.Effect<typeof todos.$inferSelect, AppError>
  remove(
    input: z.infer<typeof RemoveTodoDto>,
  ): Effect.Effect<typeof todos.$inferSelect, AppError>
}

export class TodoService extends Context.Tag('TodoService')<
  TodoService,
  ITodoService
>() {}

export const TodoServiceLive = Layer.effect(
  TodoService,
  Effect.gen(function* () {
    const db = yield* DbService
    const logger = yield* LoggerService

    return {
      create: (input) =>
        Effect.gen(function* () {
          logger.log('create', input)
          const [todo] = yield* db.query((raw) =>
            raw.insert(todos).values(input).returning(),
          )
          logger.log('created', { id: todo.id })
          return todo
        }),

      pageQuery: (input) =>
        Effect.gen(function* () {
          const { page, size, keyword, orderBy, order } = input
          return yield* db.pageQuery({
            table: todos,
            where: keyword ? ilike(todos.title, `%${keyword}%`) : undefined,
            orderCol: todos[orderBy as keyof typeof todos] as PgColumn,
            order,
            page,
            size,
          })
        }),

      cursorQuery: (input) =>
        Effect.gen(function* () {
          const { cursor, keyword, size } = input
          return yield* db.cursorQuery({
            table: todos,
            cursorColumns: [todos.updatedAt, todos.id],
            cursorValues: cursor
              ? [new Date(cursor.updatedAt), cursor.todoId]
              : undefined,
            getCursor: (item) => ({
              updatedAt: item.updatedAt.toISOString(),
              todoId: item.id,
            }),
            where: keyword ? ilike(todos.title, `%${keyword}%`) : undefined,
            size,
          })
        }),

      detail: (input) =>
        Effect.gen(function* () {
          const [todo] = yield* db.query((raw) =>
            raw.select().from(todos).where(eq(todos.id, input.todoId)),
          )
          if (!todo)
            return yield* Effect.fail(makeError(AppErrorCodes.TodoNotFound))
          return todo
        }),

      update: (input) =>
        Effect.gen(function* () {
          const { todoId, ...fields } = input
          const [todo] = yield* db.query((raw) =>
            raw
              .update(todos)
              .set(fields)
              .where(eq(todos.id, todoId))
              .returning(),
          )
          if (!todo)
            return yield* Effect.fail(makeError(AppErrorCodes.TodoNotFound))
          return todo
        }),

      remove: (input) =>
        Effect.gen(function* () {
          const [todo] = yield* db.query((raw) =>
            raw.delete(todos).where(eq(todos.id, input.todoId)).returning(),
          )
          if (!todo)
            return yield* Effect.fail(makeError(AppErrorCodes.TodoNotFound))
          return todo
        }),
    }
  }),
)
