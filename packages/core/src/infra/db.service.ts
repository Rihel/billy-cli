import { Cause, Context, Effect, Exit, Layer, Option } from 'effect'
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
import { makeError, type AppError } from '../errors.js'
import { AppErrorCodes } from '@repo/shared'
import { fromPromise } from '../effects/from-promise.js'
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
  /** Execute any Drizzle query builder. DB errors surface as AppError. */
  query<T>(fn: (raw: NodePgDatabase) => Promise<T>): Effect.Effect<T, AppError>

  /**
   * Run an Effect callback inside a DB transaction.
   * Effect failure → rollback + AppError.
   * DB error → AppError.
   */
  transaction<T, E>(
    fn: (tx: IDb) => Effect.Effect<T, E>,
  ): Effect.Effect<T, AppError>

  /** Offset-based pagination (implementation from kits). */
  pageQuery<TTable extends PgTable, T>(
    opts: PageQueryOptions<TTable, T>,
  ): Effect.Effect<PageQueryResult<T>, AppError>

  /** Cursor-based pagination (implementation from kits). */
  cursorQuery<
    TTable extends PgTable,
    TColumns extends CursorColumns,
    TCursor,
    T,
  >(
    opts: CursorQueryOptions<TTable, TColumns, TCursor, T>,
  ): Effect.Effect<CursorQueryResult<T, TCursor>, AppError>
}

export class DbService extends Context.Tag('DbService')<DbService, IDb>() {}

// ── Internal helpers ──────────────────────────────────────────────────────────

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
      fromPromise(() => fn(raw), 'query'),

    transaction: <T, E>(fn: (tx: IDb) => Effect.Effect<T, E>) =>
      Effect.tryPromise<T, AppError>({
        try: async () => {
          const exit = await raw.transaction((rawTx) =>
            Effect.runPromiseExit(fn(buildIDb(rawTx))),
          )
          if (Exit.isFailure(exit)) throw exit.cause
          return exit.value
        },
        catch: (cause) => {
          if (Cause.isCause(cause) && Cause.isFailure(cause)) {
            return Cause.failureOption(cause as Cause.Cause<AppError>).pipe(
              Option.getOrElse(() =>
                makeError(AppErrorCodes.Internal, 'transaction failed'),
              ),
            )
          }
          const detail = cause instanceof Error ? cause.message : String(cause)
          return makeError(AppErrorCodes.Internal, `transaction: ${detail}`)
        },
      }),

    pageQuery: (opts) =>
      fromPromise(() => pageQueryImpl(raw, opts), 'pageQuery'),

    cursorQuery: (opts) =>
      fromPromise(() => cursorQueryImpl(raw, opts), 'cursorQuery'),
  }
}

export const DbServiceLive = Layer.scoped(
  DbService,
  Effect.gen(function* () {
    const {
      db: { url },
    } = yield* ConfigService
    const { db: raw } = yield* Effect.acquireRelease(
      Effect.sync(() => createDb(url)),
      ({ close }) => Effect.promise(() => close().catch(() => {})),
    )
    return buildIDb(raw)
  }),
)
