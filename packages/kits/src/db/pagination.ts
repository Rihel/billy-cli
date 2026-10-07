import { Brackets, type ObjectLiteral, type SelectQueryBuilder } from 'typeorm'

// ── 结果类型 ──────────────────────────────────────────────────────────

/** 分页实现输出（{ data, total }） */
export interface PageResult<T> {
  data: T[]
  total: number
}

/** 分页实现输出（{ data, nextCursor }） */
export interface CursorResult<T> {
  data: T[]
  nextCursor: unknown
}

/** API 响应格式（service 层使用，与 @repo/sdk 的 AppPageQueryResponse 对应） */
export interface PageQueryResult<T> {
  items: T[]
  total: number
  page: number
  size: number
}

/** API 响应格式（service 层使用） */
export interface CursorQueryResult<T, TCursor> {
  items: T[]
  nextCursor: TCursor | null
}

export type CursorColumns<T> = readonly [keyof T, ...(keyof T)[]]

// ── 页码分页：LIMIT / OFFSET ──────────────────────────────────────────

/**
 * 对已构建好的 QueryBuilder 做页码分页。
 * 调用方负责 where / orderBy / join，本函数只做 skip / take + count。
 */
export async function pageWith<T extends ObjectLiteral>(
  builder: SelectQueryBuilder<T>,
  page: number,
  size: number,
): Promise<PageResult<T>> {
  const [data, total] = await Promise.all([
    builder.clone().skip((page - 1) * size).take(size).getMany(),
    builder.clone().getCount(),
  ])
  return { data, total }
}

// ── 两阶段页码分页：先主键分页，再按主键加载详情 ──────────────────────

export interface DeferredPageOptions<T extends ObjectLiteral> {
  /** 构建"只取主键"的分页查询（含 where / orderBy） */
  selectIds: () => SelectQueryBuilder<T>
  /** 按主键集合加载详情 */
  fetchIds: (ids: T[keyof T][]) => Promise<T[]>
  idCol: keyof T
  page: number
  size: number
}

export async function pageWithDeferred<T extends ObjectLiteral>(
  options: DeferredPageOptions<T>,
): Promise<PageResult<T>> {
  const { selectIds, fetchIds, idCol, page, size } = options
  const idPage = await pageWith(selectIds().select(String(idCol)), page, size)
  if (idPage.total === 0) return { data: [], total: 0 }
  const ids = idPage.data.map((row) => row[idCol])
  const data = await fetchIds(ids)
  return { data, total: idPage.total }
}

// ── Cursor / Seek 分页（复合键）───────────────────────────────────────

export interface CursorPageOptions<T> {
  /** 排序的复合键列（决定 seek 条件的比较顺序） */
  cursorColumns: CursorColumns<T>
  /** 上一页的游标值；首屏不传 */
  cursorValues?: unknown[]
  /** 由行生成下一页游标 */
  getCursor: (row: T) => unknown
  /** 与调用方 builder 的排序方向一致 */
  order?: 'asc' | 'desc'
  size: number
}

/**
 * 对已构建好的 QueryBuilder 做 Cursor/Seek 分页。
 * 调用方负责 where / orderBy（必须与 cursorColumns + order 一致），
 * 本函数负责拼接复合键 seek 条件并多取一条判断是否有下一页。
 */
export async function cursorPageWith<T extends ObjectLiteral>(
  builder: SelectQueryBuilder<T>,
  options: CursorPageOptions<T>,
): Promise<CursorResult<T>> {
  const { cursorColumns, cursorValues, getCursor, order = 'desc', size } = options
  if (cursorValues) {
    applyCursorFilter(builder, cursorColumns, cursorValues, order)
  }
  const rows = await builder.take(size + 1).getMany()
  const hasMore = rows.length > size
  const data = hasMore ? rows.slice(0, size) : rows
  const last = data.at(-1)
  return { data, nextCursor: hasMore && last ? getCursor(last) : null }
}

// ── 两阶段 Cursor 分页：先定位主键，再按主键加载详情 ──────────────────

export interface DeferredCursorOptions<T> extends CursorPageOptions<T> {
  /** 按主键集合加载详情 */
  fetchIds: (ids: T[keyof T][]) => Promise<T[]>
  idCol: keyof T
}

export async function cursorPageWithDeferred<T extends ObjectLiteral>(
  builder: SelectQueryBuilder<T>,
  options: DeferredCursorOptions<T>,
): Promise<CursorResult<T>> {
  const { fetchIds, idCol, ...pageOptions } = options
  const page = await cursorPageWith(
    builder.select([
      String(idCol),
      ...pageOptions.cursorColumns.map(String),
    ]),
    pageOptions,
  )
  if (page.data.length === 0) return page
  const ids = page.data.map((row) => row[idCol])
  const data = await fetchIds(ids)
  return { data, nextCursor: page.nextCursor }
}

// ── 复合键 seek 条件 ──────────────────────────────────────────────────
// (c0 > v0) OR (c0 = v0 AND c1 > v1) OR (c0 = v0 AND c1 = v1 AND c2 > v2) ...

function applyCursorFilter<T extends ObjectLiteral>(
  builder: SelectQueryBuilder<T>,
  columns: CursorColumns<T>,
  values: unknown[],
  order: 'asc' | 'desc',
) {
  const dir = order === 'asc' ? '>' : '<'
  const alias = builder.alias
  builder.andWhere(
    new Brackets((outer) => {
      columns.forEach((column, index) => {
        outer.orWhere(
          new Brackets((inner) => {
            for (let i = 0; i < index; i++) {
              inner.andWhere(`${alias}.${String(columns[i])} = :cursor${i}`, {
                [`cursor${i}`]: values[i],
              })
            }
            inner.andWhere(
              `${alias}.${String(column)} ${dir} :cursor${index}`,
              { [`cursor${index}`]: values[index] },
            )
          }),
        )
      })
    }),
  )
}
