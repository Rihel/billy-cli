import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { todos } from '@repo/db'
import { DbService } from '../src/infra/db.service.js'
import { runEffect } from './helpers/integration.js'

describe('DbService with real PostgreSQL', () => {
  it('executes real Drizzle queries', async () => {
    const row = await runEffect(
      Effect.gen(function* () {
        const db = yield* DbService
        const [created] = yield* db.query((raw) =>
          raw.insert(todos).values({ title: 'DB query' }).returning(),
        )
        const [selected] = yield* db.query((raw) =>
          raw.select().from(todos).where(eq(todos.id, created.id)),
        )
        return selected
      }),
    )
    expect(row.title).toBe('DB query')
  })

  it('rolls back a failed Effect transaction', async () => {
    const result = await runEffect(
      Effect.gen(function* () {
        const db = yield* DbService
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.query((raw) =>
                raw.insert(todos).values({ title: 'Rollback me' }),
              )
              return yield* Effect.fail('rollback' as const)
            }),
          )
          .pipe(Effect.either)
      }),
    )
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left).toBe('rollback')

    const rows = await runEffect(
      Effect.flatMap(DbService, (db) =>
        db.query((raw) =>
          raw.select().from(todos).where(eq(todos.title, 'Rollback me')),
        ),
      ),
    )
    expect(rows).toHaveLength(0)
  })
})
