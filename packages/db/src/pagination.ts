import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  lt,
  or,
  type InferSelectModel,
  type SQL,
} from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

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

export interface PageQueryDeferredOptions<
  TTable extends PgTable,
  TId,
  T = InferSelectModel<TTable>,
> {
  table: TTable
  idCol: PgColumn
  where?: SQL
  orderCol?: PgColumn
  order?: 'asc' | 'desc'
  page: number
  size: number
  dataFn: (ids: TId[]) => Promise<T[]>
  getItemId: (item: T) => TId
}

export interface PageQueryResult<T> {
  items: T[]
  total: number
  page: number
  size: number
}

export type CursorColumns = readonly [PgColumn, ...PgColumn[]]

export type CursorValues<TColumns extends CursorColumns> = {
  [Index in keyof TColumns]: TColumns[Index] extends PgColumn
    ? TColumns[Index]['_']['data']
    : never
}

export interface CursorQueryOptions<
  TTable extends PgTable,
  TColumns extends CursorColumns,
  TCursor,
  T = InferSelectModel<TTable>,
> {
  table: TTable
  cursorColumns: TColumns
  cursorValues?: CursorValues<TColumns>
  getCursor: (row: InferSelectModel<TTable>) => TCursor
  where?: SQL
  order?: 'asc' | 'desc'
  size: number
  map?: (row: InferSelectModel<TTable>) => T
}

export interface CursorQueryDeferredOptions<
  TTable extends PgTable,
  TColumns extends CursorColumns,
  TCursor,
  TId,
  T,
> {
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
}

export interface CursorQueryResult<T, TCursor> {
  items: T[]
  nextCursor: TCursor | null
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

export async function pageQuery<
  TTable extends PgTable,
  T = InferSelectModel<TTable>,
>(
  db: NodePgDatabase,
  opts: PageQueryOptions<TTable, T>,
): Promise<PageQueryResult<T>> {
  const { table, where, orderCol, order = 'desc', page, size, map } = opts
  const orderExpr = orderCol
    ? order === 'asc'
      ? asc(orderCol)
      : desc(orderCol)
    : undefined
  const dbTable = table as PgTable
  const baseQuery = db.select().from(dbTable).where(where)
  const [rows, [{ total }]] = await Promise.all([
    (orderExpr ? baseQuery.orderBy(orderExpr) : baseQuery)
      .limit(size)
      .offset((page - 1) * size),
    db.select({ total: count() }).from(dbTable).where(where),
  ])
  const items = map
    ? (rows as InferSelectModel<TTable>[]).map(map)
    : (rows as T[])
  return { items, total: Number(total), page, size }
}

export async function pageQueryDeferred<
  TTable extends PgTable,
  TId,
  T = InferSelectModel<TTable>,
>(
  db: NodePgDatabase,
  opts: PageQueryDeferredOptions<TTable, TId, T>,
): Promise<PageQueryResult<T>> {
  const {
    table,
    idCol,
    where,
    orderCol,
    order = 'desc',
    page,
    size,
    dataFn,
    getItemId,
  } = opts
  const orderExpr = orderCol
    ? order === 'asc'
      ? asc(orderCol)
      : desc(orderCol)
    : undefined
  const dbTable = table as PgTable
  const idQuery = db.select({ id: idCol }).from(dbTable).where(where)
  const [idRows, [{ total }]] = await Promise.all([
    (orderExpr ? idQuery.orderBy(orderExpr) : idQuery)
      .limit(size)
      .offset((page - 1) * size),
    db.select({ total: count() }).from(dbTable).where(where),
  ])
  const ids = idRows.map((row) => row.id as TId)
  const loadedItems = ids.length > 0 ? await dataFn(ids) : []
  const itemsById = new Map<TId, T[]>()
  for (const item of loadedItems) {
    const id = getItemId(item)
    const group = itemsById.get(id)
    if (group) group.push(item)
    else itemsById.set(id, [item])
  }
  return {
    items: ids.flatMap((id) => itemsById.get(id) ?? []),
    total: Number(total),
    page,
    size,
  }
}

export async function cursorQuery<
  TTable extends PgTable,
  TColumns extends CursorColumns,
  TCursor,
  T = InferSelectModel<TTable>,
>(
  db: NodePgDatabase,
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
  const rows = (await db
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

export async function cursorQueryDeferred<
  TTable extends PgTable,
  TColumns extends CursorColumns,
  TCursor,
  TId,
  T,
>(
  db: NodePgDatabase,
  opts: CursorQueryDeferredOptions<TTable, TColumns, TCursor, TId, T>,
): Promise<CursorQueryResult<T, TCursor>> {
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
  const rows = await db
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
  for (const item of loadedItems) {
    const id = getItemId(item)
    const group = itemsById.get(id)
    if (group) group.push(item)
    else itemsById.set(id, [item])
  }
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
