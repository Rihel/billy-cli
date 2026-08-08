import { Inject, Injectable } from '@nestjs/common'
import {
  createDb,
  cursorQuery,
  cursorQueryDeferred,
  pageQuery,
  pageQueryDeferred,
} from '@repo/db'
import { batchExecute } from '@repo/shared'
import {
  inArray,
  type InferInsertModel,
  type InferSelectModel,
} from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgColumn, PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core'
import {
  DATABASE_MODULE_OPTIONS,
  type DatabaseModuleOptions,
} from './database.options.js'
import type {
  PageQueryOptions,
  PageQueryResult,
  CursorQueryOptions,
  CursorQueryResult,
  BatchOptions,
  CursorColumns,
  CursorValues,
  CursorQueryDeferredOptions,
  PageQueryDeferredOptions,
} from './types.js'

@Injectable()
export class DbService {
  private readonly db: NodePgDatabase

  constructor(@Inject(DATABASE_MODULE_OPTIONS) options: DatabaseModuleOptions) {
    this.db = createDb(options.url).db
  }

  get select() {
    return this.db.select.bind(this.db)
  }

  get insert() {
    return this.db.insert.bind(this.db)
  }

  get update() {
    return this.db.update.bind(this.db)
  }

  get delete() {
    return this.db.delete.bind(this.db)
  }

  transaction<T>(fn: (tx: NodePgDatabase) => Promise<T>): Promise<T> {
    return this.db.transaction(fn) as Promise<T>
  }

  async batch<T>(
    items: readonly T[],
    handler: (chunk: T[]) => Promise<unknown>,
    options: BatchOptions = {},
  ): Promise<void> {
    await batchExecute(items, handler, options)
  }

  async batchInsert<TTable extends PgTable>(
    table: TTable,
    values: readonly InferInsertModel<TTable>[],
    options?: BatchOptions,
  ): Promise<void> {
    await this.batch(
      values,
      (chunk) => this.db.insert(table).values(chunk),
      options,
    )
  }

  async batchDelete<TTable extends PgTable, TIdColumn extends PgColumn>(
    table: TTable,
    idColumn: TIdColumn,
    ids: readonly TIdColumn['_']['data'][],
    options?: BatchOptions,
  ): Promise<void> {
    await this.batch(
      ids,
      (chunk) => this.db.delete(table).where(inArray(idColumn, chunk)),
      options,
    )
  }

  async batchUpdate<TTable extends PgTable, TIdColumn extends PgColumn>(
    table: TTable,
    idColumn: TIdColumn,
    ids: readonly TIdColumn['_']['data'][],
    values: PgUpdateSetSource<TTable>,
    options?: BatchOptions,
  ): Promise<void> {
    await this.batch(
      ids,
      (chunk) =>
        this.db.update(table).set(values).where(inArray(idColumn, chunk)),
      options,
    )
  }

  async pageQuery<TTable extends PgTable, T = InferSelectModel<TTable>>(
    opts: PageQueryOptions<TTable, T>,
  ): Promise<PageQueryResult<T>> {
    return pageQuery(this.db, opts)
  }

  async cursorQuery<
    TTable extends PgTable,
    TColumns extends CursorColumns,
    TCursor,
    T = InferSelectModel<TTable>,
  >(
    opts: CursorQueryOptions<TTable, TColumns, TCursor, T>,
  ): Promise<CursorQueryResult<T, TCursor>> {
    return cursorQuery(this.db, opts)
  }

  async cursorQueryDeferred<
    TTable extends PgTable,
    TColumns extends CursorColumns,
    TCursor,
    TId,
    T,
  >(
    opts: CursorQueryDeferredOptions<TTable, TColumns, TCursor, TId, T>,
  ): Promise<CursorQueryResult<T, TCursor>> {
    return cursorQueryDeferred(this.db, opts)
  }

  async pageQueryDeferred<TTable extends PgTable, TId, T>(
    opts: PageQueryDeferredOptions<TTable, TId, T>,
  ): Promise<PageQueryResult<T>> {
    return pageQueryDeferred(this.db, opts)
  }
}
