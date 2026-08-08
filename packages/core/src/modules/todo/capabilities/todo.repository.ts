import { todos, type CursorQueryResult, type PageQueryResult } from '@repo/db'
import { Context, Effect, Layer } from 'effect'
import { eq, ilike } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import { Db, type DbError } from '../../../shared/database.capability.js'
import {
  Todo,
  TodoCursor,
  type TodoCursorQuery,
  type TodoPageQuery,
} from '../domain.js'

type TodoRecord = typeof todos.$inferSelect

const toTodo = (record: TodoRecord) => new Todo(record)

export interface TodoRepositoryApi {
  create(data: typeof todos.$inferInsert): Effect.Effect<Todo, DbError>
  findById(id: string): Effect.Effect<Todo | undefined, DbError>
  update(
    id: string,
    data: Partial<typeof todos.$inferInsert>,
  ): Effect.Effect<Todo | undefined, DbError>
  remove(id: string): Effect.Effect<Todo | undefined, DbError>
  page(query: TodoPageQuery): Effect.Effect<PageQueryResult<Todo>, DbError>
  cursor(
    query: TodoCursorQuery,
  ): Effect.Effect<CursorQueryResult<Todo, TodoCursor>, DbError>
}

export class TodoRepository extends Context.Tag('TodoRepository')<
  TodoRepository,
  TodoRepositoryApi
>() {}

export const TodoRepositoryLive = Layer.effect(
  TodoRepository,
  Effect.gen(function* () {
    const db = yield* Db
    return {
      create: (data) =>
        db.query((raw) =>
          raw
            .insert(todos)
            .values(data)
            .returning()
            .then(([todo]) => toTodo(todo)),
        ),
      findById: (id) =>
        db.query((raw) =>
          raw
            .select()
            .from(todos)
            .where(eq(todos.id, id))
            .then(([todo]) => (todo ? toTodo(todo) : undefined)),
        ),
      update: (id, data) =>
        db.query((raw) =>
          raw
            .update(todos)
            .set(data)
            .where(eq(todos.id, id))
            .returning()
            .then(([todo]) => (todo ? toTodo(todo) : undefined)),
        ),
      remove: (id) =>
        db.query((raw) =>
          raw
            .delete(todos)
            .where(eq(todos.id, id))
            .returning()
            .then(([todo]) => (todo ? toTodo(todo) : undefined)),
        ),
      page: ({ page, size, keyword, orderBy = 'updatedAt', order = 'desc' }) =>
        db.pageQuery({
          table: todos,
          where: keyword ? ilike(todos.title, `%${keyword}%`) : undefined,
          orderCol: todos[orderBy] as PgColumn,
          order,
          page,
          size,
          map: toTodo,
        }),
      cursor: ({ cursor, keyword, size }) =>
        db.cursorQuery({
          table: todos,
          cursorColumns: [todos.updatedAt, todos.id],
          cursorValues: cursor
            ? [new Date(cursor.updatedAt), cursor.todoId]
            : undefined,
          getCursor: (todo) =>
            new TodoCursor({
              updatedAt: todo.updatedAt.toISOString(),
              todoId: todo.id,
            }),
          where: keyword ? ilike(todos.title, `%${keyword}%`) : undefined,
          size,
          map: toTodo,
        }),
    } satisfies TodoRepositoryApi
  }),
)
