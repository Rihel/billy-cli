import { BatchExecuteOptions } from '@repo/shared'
import { InferSelectModel, SQL } from 'drizzle-orm'
import { PgColumn, PgTable } from 'drizzle-orm/pg-core'

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
export interface CursorQueryResult<T, TCursor> {
  items: T[]
  nextCursor: TCursor | null
}

export type BatchOptions = BatchExecuteOptions

export type CursorColumns = readonly [PgColumn, ...PgColumn[]]
export type CursorValues<TColumns extends CursorColumns> = {
  [Index in keyof TColumns]: TColumns[Index] extends PgColumn
    ? TColumns[Index]['_']['data']
    : never
}

export type CursorQueryDeferredOptions<
  TTable extends PgTable,
  TColumns extends CursorColumns,
  TCursor,
  TId,
  T,
> = {
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
