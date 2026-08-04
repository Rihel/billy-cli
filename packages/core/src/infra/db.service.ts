import { Context, Effect, Layer } from 'effect'
import {
  and,
  asc,
  count,
  desc,
  gt,
  lt,
  or,
  eq,
  type InferSelectModel,
  type SQL,
} from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { createDb } from '@repo/db'
import { ConfigService } from './config.service.js'

// ── Pagination types (moved from kits) ───────────────────────────────────────

export interface PageQueryOptions<
  TTable extends PgTable,
  T = InferSelectModel<TTable>,
> {
  table: TTable
  where?: SQL
  orderCol?: PgColumn
  order?: 'asc' | 'desc'
  page: number
  size: number
  map?: (row: InferSelectModel<TTable>) => T
}

export interface PageQueryResult<T> {
  items: T[]
  total: number
  page: number
  size: number
}

export type CursorColumns = PgColumn[]

export interface CursorQueryOptions<
  TTable extends PgTable,
  TColumns extends CursorColumns,
  TCursor,
  T = InferSelectModel<TTable>,
> {
  table: TTable
  cursorColumns: TColumns
  cursorValues?: any[]
  getCursor: (row: InferSelectModel<TTable>) => TCursor
  where?: SQL
  order?: 'asc' | 'desc'
  size: number
  map?: (row: InferSelectModel<TTable>) => T
}

export interface CursorQueryResult<T, TCursor> {
  items: T[]
  nextCursor: TCursor | null
}

// ── IDb: fully Effect-native interface ───────────────────────────────────────

export interface IDb {
  /** Execute any Drizzle query builder. DB errors surface as defects. */
  query<T>(fn: (raw: NodePgDatabase) => Promise<T>): Effect.Effect<T>

  /**
   * Run an Effect callback inside a DB transaction.
   * Effect failure → rollback + re-raise error.
   * DB error → die (defect).
   */
  transaction<T, E>(fn: (tx: IDb) => Effect.Effect<T, E>): Effect.Effect<T, E>

  /** Offset-based pagination (implementation from kits). */
  pageQuery<TTable extends PgTable, T>(
    opts: PageQueryOptions<TTable, T>,
  ): Effect.Effect<PageQueryResult<T>>

  /** Cursor-based pagination (implementation from kits). */
  cursorQuery<
    TTable extends PgTable,
    TColumns extends CursorColumns,
    TCursor,
    T,
  >(
    opts: CursorQueryOptions<TTable, TColumns, TCursor, T>,
  ): Effect.Effect<CursorQueryResult<T, TCursor>>
}

export class DbService extends Context.Tag('DbService')<DbService, IDb>() {}

// ── Internal helpers ──────────────────────────────────────────────────────────

class RollbackSignal {
  constructor(readonly error: unknown) {}
}

function createCursorFilter(
  columns: CursorColumns,
  values: any[] | undefined,
  order: 'asc' | 'desc',
): SQL | undefined {
  if (!values) return undefined
  const compare = order === 'asc' ? gt : lt
  return or(
    ...columns.map((col, i) =>
      and(
        ...columns.slice(0, i).map((prev, pi) => eq(prev, values[pi])),
        compare(col, values[i]),
      ),
    ),
  ) as SQL
}

function createCursorOrder(columns: CursorColumns, order: 'asc' | 'desc') {
  return columns.map((col) => (order === 'asc' ? asc(col) : desc(col)))
}

// ── pageQuery / cursorQuery implementations (moved from kits) ─────────────────

async function pageQueryImpl<TTable extends PgTable, T>(
  raw: NodePgDatabase,
  opts: PageQueryOptions<TTable, T>,
): Promise<PageQueryResult<T>> {
  const { table, where, orderCol, order = 'desc', page, size, map } = opts
  const offset = (page - 1) * size
  const orderExpr = orderCol
    ? order === 'asc'
      ? asc(orderCol)
      : desc(orderCol)
    : undefined
  const base = raw
    .select()
    .from(table as PgTable)
    .where(where)
  const [rows, [{ total }]] = await Promise.all([
    (orderExpr ? base.orderBy(orderExpr) : base).limit(size).offset(offset),
    raw
      .select({ total: count() })
      .from(table as PgTable)
      .where(where),
  ])
  return {
    items: map ? (rows as InferSelectModel<TTable>[]).map(map) : (rows as T[]),
    total: Number(total),
    page,
    size,
  }
}

async function cursorQueryImpl<
  TTable extends PgTable,
  TColumns extends CursorColumns,
  TCursor,
  T,
>(
  raw: NodePgDatabase,
  opts: CursorQueryOptions<TTable, TColumns, TCursor, T>,
): Promise<CursorQueryResult<T, TCursor>> {
  const {
    table,
    cursorColumns,
    cursorValues,
    getCursor,
    where,
    order = 'desc',
    size,
    map,
  } = opts
  const rows = (await raw
    .select()
    .from(table as PgTable)
    .where(and(where, createCursorFilter(cursorColumns, cursorValues, order)))
    .orderBy(...createCursorOrder(cursorColumns, order))
    .limit(size + 1)) as InferSelectModel<TTable>[]
  const hasMore = rows.length > size
  const pageRows = hasMore ? rows.slice(0, size) : rows
  const last = pageRows.at(-1)
  return {
    items: map ? pageRows.map(map) : (pageRows as T[]),
    nextCursor: hasMore && last ? getCursor(last) : null,
  }
}

// ── buildIDb + DbServiceLive ──────────────────────────────────────────────────

function buildIDb(raw: NodePgDatabase): IDb {
  return {
    query: <T>(fn: (db: NodePgDatabase) => Promise<T>) =>
      Effect.promise(() => fn(raw)),

    transaction: <T, E>(fn: (tx: IDb) => Effect.Effect<T, E>) =>
      Effect.async<T, E>((resume) => {
        raw
          .transaction(async (rawTx) => {
            const txDb = buildIDb(rawTx)
            const either = await Effect.runPromise(Effect.either(fn(txDb)))
            if (either._tag === 'Left') throw new RollbackSignal(either.left)
            return either.right
          })
          .then(
            (result) => resume(Effect.succeed(result)),
            (err) =>
              err instanceof RollbackSignal
                ? resume(Effect.fail(err.error as E))
                : resume(Effect.die(err)),
          )
      }),

    pageQuery: (opts) => Effect.promise(() => pageQueryImpl(raw, opts)),

    cursorQuery: (opts) => Effect.promise(() => cursorQueryImpl(raw, opts)),
  }
}

export const DbServiceLive = Layer.scoped(
  DbService,
  Effect.gen(function* () {
    const {
      db: { url },
    } = yield* ConfigService
    const raw = createDb(url)
    yield* Effect.addFinalizer(() =>
      Effect.promise(
        () =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (raw as any).$client?.end?.().catch(() => {}) ?? Promise.resolve(),
      ),
    )
    return buildIDb(raw)
  }),
)
