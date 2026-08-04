import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { AppErrorCodes } from '@repo/shared'
import { todos } from '@repo/db'
import { TodoService } from '../src/biz/todo.service.js'
import { DbService } from '../src/infra/db.service.js'
import { runEffect } from './helpers/integration.js'

const runTodo = <A, E>(
  use: (service: TodoService['Type']) => Effect.Effect<A, E>,
) => runEffect(Effect.flatMap(TodoService, use))

describe('TodoService with real PostgreSQL', () => {
  it('creates, reads, updates, and removes a persisted todo', async () => {
    const created = await runTodo((todo) =>
      todo.create({ title: 'Buy milk', description: 'Two bottles' }),
    )
    expect(created.id).toBeTruthy()

    expect(
      (await runTodo((todo) => todo.detail({ todoId: created.id }))).title,
    ).toBe('Buy milk')

    const updated = await runTodo((todo) =>
      todo.update({
        todoId: created.id,
        title: 'Buy oat milk',
        completed: true,
      }),
    )
    expect(updated.completed).toBe(true)

    expect(
      (await runTodo((todo) => todo.remove({ todoId: created.id }))).id,
    ).toBe(created.id)
    const missing = await runTodo((todo) =>
      todo.detail({ todoId: created.id }).pipe(Effect.either),
    )
    expect(missing._tag).toBe('Left')
    if (missing._tag === 'Left')
      expect(missing.left.code).toBe(AppErrorCodes.TodoNotFound)
  })

  it('runs real offset and cursor pagination queries', async () => {
    for (const title of ['Alpha', 'Beta', 'Gamma']) {
      await runTodo((todo) => todo.create({ title }))
    }
    await runEffect(
      Effect.flatMap(DbService, (db) =>
        db.query((raw) =>
          raw
            .update(todos)
            .set({ updatedAt: new Date('2026-01-01T00:00:00.123Z') }),
        ),
      ),
    )

    const page = await runTodo((todo) =>
      todo.pageQuery({ page: 1, size: 2, orderBy: 'createdAt', order: 'asc' }),
    )
    expect(page.total).toBe(3)
    expect(page.items).toHaveLength(2)

    const first = await runTodo((todo) => todo.cursorQuery({ size: 2 }))
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()

    const second = await runTodo((todo) =>
      todo.cursorQuery({ size: 2, cursor: first.nextCursor! }),
    )
    expect(second.items).toHaveLength(1)
  })

  it('filters persisted todos by keyword', async () => {
    await runTodo((todo) => todo.create({ title: 'Visible task' }))
    await runTodo((todo) => todo.create({ title: 'Hidden item' }))

    const page = await runTodo((todo) =>
      todo.pageQuery({
        page: 1,
        size: 10,
        keyword: 'Visible',
        orderBy: 'createdAt',
        order: 'desc',
      }),
    )
    expect(page.items.map((item: { title: string }) => item.title)).toEqual([
      'Visible task',
    ])
  })
})
