import { Inject, Injectable } from '@nestjs/common'
import { createDb } from '@repo/db'
import { batchExecute, type BatchExecuteOptions } from '@repo/shared'
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  lt,
  or,
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
} from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgColumn, PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core'
import {
  DATABASE_MODULE_OPTIONS,
  type DatabaseModuleOptions,
} from './database.options.js'

export interface PageResult<T> {
  items: T[]
  total: number
  page: number
  size: number
}

export interface CursorPageResult<T, TCursor> {
  items: T[]
  nextCursor: TCursor | null
}

export type BatchOptions = BatchExecuteOptions
type CursorColumns = readonly [PgColumn, ...PgColumn[]]
type CursorValues<TColumns extends CursorColumns> = {
  [Index in keyof TColumns]: TColumns[Index] extends PgColumn
    ? TColumns[Index]['_']['data']
    : never
}

function createCursorFilter<TColumns extends CursorColumns>(
  columns: TColumns,
  values: CursorValues<TColumns> | undefined,
  order: 'asc' | 'desc',
) {
  if (!values) return undefined
  const compare = order === 'asc' ? gt : lt
  return or(
    ...columns.map((column, index) =>
      and(
        ...columns
          .slice(0, index)
          .map((previousColumn, previousIndex) =>
            eq(previousColumn, values[previousIndex]),
          ),
        compare(column, values[index]),
      ),
    ),
  )
}

function createCursorOrder(columns: CursorColumns, order: 'asc' | 'desc') {
  return columns.map((column) => (order === 'asc' ? asc(column) : desc(column)))
}

@Injectable()
export class DbService {
  private readonly db: NodePgDatabase

  constructor(@Inject(DATABASE_MODULE_OPTIONS) options: DatabaseModuleOptions) {
    this.db = createDb(options.url)
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

  async paginate<TTable extends PgTable, T = InferSelectModel<TTable>>(opts: {
    table: TTable
    where?: SQL
    orderCol?: PgColumn
    order?: 'asc' | 'desc'
    page: number
    size: number
    map?: (row: InferSelectModel<TTable>) => T
  }): Promise<PageResult<T>> {
    const { table, where, orderCol, order = 'desc', page, size, map } = opts
    const offset = (page - 1) * size
    const orderExpr = orderCol
      ? order === 'asc'
        ? asc(orderCol)
        : desc(orderCol)
      : undefined
    const dbTable = table as PgTable
    const baseQuery = this.db.select().from(dbTable).where(where)
    const [rows, [{ total }]] = await Promise.all([
      (orderExpr ? baseQuery.orderBy(orderExpr) : baseQuery)
        .limit(size)
        .offset(offset),
      this.db.select({ total: count() }).from(dbTable).where(where),
    ])
    const items = map
      ? (rows as InferSelectModel<TTable>[]).map(map)
      : (rows as T[])
    return { items, total: Number(total), page, size }
  }

  async paginateCursor<
    TTable extends PgTable,
    TColumns extends CursorColumns,
    TCursor,
    T = InferSelectModel<TTable>,
  >(opts: {
    table: TTable
    cursorColumns: TColumns
    cursorValues?: CursorValues<TColumns>
    getCursor: (row: InferSelectModel<TTable>) => TCursor
    where?: SQL
    order?: 'asc' | 'desc'
    size: number
    map?: (row: InferSelectModel<TTable>) => T
  }): Promise<CursorPageResult<T, TCursor>> {
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
    const rows = (await this.db
      .select()
      .from(table as PgTable)
      .where(and(where, createCursorFilter(cursorColumns, cursorValues, order)))
      .orderBy(...createCursorOrder(cursorColumns, order))
      .limit(size + 1)) as InferSelectModel<TTable>[]
    const hasMore = rows.length > size
    const pageRows = hasMore ? rows.slice(0, size) : rows
    const lastRow = pageRows.at(-1)
    return {
      items: map ? pageRows.map(map) : (pageRows as T[]),
      nextCursor: hasMore && lastRow ? getCursor(lastRow) : null,
    }
  }

  async paginateCursorDeferred<
    TTable extends PgTable,
    TColumns extends CursorColumns,
    TCursor,
    TId,
    T,
  >(opts: {
    table: TTable
    idCol: PgColumn
    cursorColumns: TColumns
    cursorValues?: CursorValues<TColumns>
    getCursor: (values: CursorValues<TColumns>) => TCursor
    where?: SQL
    order?: 'asc' | 'desc'
    size: number
    dataFn: (ids: TId[]) => Promise<T[]>
    getItemId: (item: T) => TId
  }): Promise<CursorPageResult<T, TCursor>> {
    const {
      table,
      idCol,
      cursorColumns,
      cursorValues,
      getCursor,
      where,
      order = 'desc',
      size,
      dataFn,
      getItemId,
    } = opts
    const selection: Record<string, PgColumn> = { id: idCol }
    cursorColumns.forEach((column, index) => {
      selection[`cursor${index}`] = column
    })
    const rows = await this.db
      .select(selection)
      .from(table as PgTable)
      .where(and(where, createCursorFilter(cursorColumns, cursorValues, order)))
      .orderBy(...createCursorOrder(cursorColumns, order))
      .limit(size + 1)
    const hasMore = rows.length > size
    const pageRows = hasMore ? rows.slice(0, size) : rows
    const ids = pageRows.map((row) => row.id as TId)
    const loadedItems = ids.length > 0 ? await dataFn(ids) : []
    const itemsById = new Map<TId, T[]>()
    loadedItems.forEach((item) => {
      const id = getItemId(item)
      const group = itemsById.get(id)
      if (group) group.push(item)
      else itemsById.set(id, [item])
    })
    const lastRow = pageRows.at(-1)
    const lastCursorValues = lastRow
      ? (cursorColumns.map(
          (_, index) => lastRow[`cursor${index}`],
        ) as CursorValues<TColumns>)
      : undefined
    return {
      items: ids.flatMap((id) => itemsById.get(id) ?? []),
      nextCursor:
        hasMore && lastCursorValues ? getCursor(lastCursorValues) : null,
    }
  }

  async paginateDeferred<TTable extends PgTable, TId, T>(opts: {
    table: TTable
    idCol: PgColumn
    where?: SQL
    orderCol?: PgColumn
    order?: 'asc' | 'desc'
    page: number
    size: number
    dataFn: (ids: TId[]) => Promise<T[]>
  }): Promise<PageResult<T>> {
    const {
      table,
      idCol,
      where,
      orderCol,
      order = 'desc',
      page,
      size,
      dataFn,
    } = opts
    const orderExpr = orderCol
      ? order === 'asc'
        ? asc(orderCol)
        : desc(orderCol)
      : undefined
    const dbTable = table as PgTable
    const idQuery = this.db.select({ id: idCol }).from(dbTable).where(where)
    const [idRows, [{ total }]] = await Promise.all([
      (orderExpr ? idQuery.orderBy(orderExpr) : idQuery)
        .limit(size)
        .offset((page - 1) * size),
      this.db.select({ total: count() }).from(dbTable).where(where),
    ])
    const ids = idRows.map((row) => row.id as TId)
    const items = ids.length > 0 ? await dataFn(ids) : []
    return { items, total: Number(total), page, size }
  }
}
