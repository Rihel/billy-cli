import { Injectable } from '@nestjs/common';
import { createDb } from '@repo/db';
import { batchExecute, type BatchExecuteOptions } from '@repo/shared';
import {
  InferInsertModel,
  InferSelectModel,
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  lt,
  or,
  SQL,
} from 'drizzle-orm';
import { PgColumn, PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { appConfig } from '../config.js';

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface CursorPageResult<T, TCursor> {
  items: T[];
  nextCursor: TCursor | null;
}

export type BatchOptions = BatchExecuteOptions;

type CursorColumns = readonly [PgColumn, ...PgColumn[]];

/**
 * 根据 cursor 列推导对应值的 tuple 类型。
 * 例如列为 `[timestampColumn, varcharColumn]` 时，值必须是 `[Date, string]`。
 */
type CursorValues<TColumns extends CursorColumns> = {
  [Index in keyof TColumns]: TColumns[Index] extends PgColumn
    ? TColumns[Index]['_']['data']
    : never;
};

const createCursorFilter = <TColumns extends CursorColumns>(
  columns: TColumns,
  values: CursorValues<TColumns> | undefined,
  order: 'asc' | 'desc',
) => {
  if (!values) return undefined;
  const compare = order === 'asc' ? gt : lt;

  // 构造多列字典序比较。以 DESC 的 [updatedAt, id] 为例：
  // updatedAt < cursor.updatedAt
  // OR (updatedAt = cursor.updatedAt AND id < cursor.id)
  // nanoid 虽然随机，但唯一且创建后不变，可以作为最后一个稳定 tie-breaker。
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
  );
};

const createCursorOrder = (columns: CursorColumns, order: 'asc' | 'desc') =>
  columns.map((column) => (order === 'asc' ? asc(column) : desc(column)));

@Injectable()
export class DbService {
  private readonly _db: NodePgDatabase;

  constructor() {
    this._db = createDb(appConfig.dbUrl);
  }

  get select() {
    return this._db.select.bind(this._db);
  }

  get insert() {
    return this._db.insert.bind(this._db);
  }

  get update() {
    return this._db.update.bind(this._db);
  }

  get delete() {
    return this._db.delete.bind(this._db);
  }

  transaction<T>(fn: (tx: NodePgDatabase) => Promise<T>): Promise<T> {
    return this._db.transaction(fn) as Promise<T>;
  }

  /**
   * 通用分片执行器，将大量数据拆成多片并限制并发数。
   *
   * 各片是独立 SQL，不保证整体原子性。需要全量成功或失败时，应在业务层使用事务，
   * 并将 `concurrency` 设为 1，避免在同一个事务连接上并发执行语句。
   *
   * @example 不同记录需要不同更新值时，可以直接使用 batch
   * ```ts
   * await db.batch(inputs, async (chunk) => {
   *   await Promise.all(
   *     chunk.map((item) =>
   *       db.update(todos).set(item.data).where(eq(todos.id, item.id)),
   *     ),
   *   )
   * })
   * ```
   */
  async batch<T>(
    items: readonly T[],
    handler: (chunk: T[]) => Promise<unknown>,
    options: BatchOptions = {},
  ): Promise<void> {
    await batchExecute(items, handler, options);
  }

  /**
   * 分片批量插入，每片生成一条 `INSERT ... VALUES (...)`。
   *
   * @example
   * ```ts
   * await db.batchInsert(todos, inputs, {
   *   chunkSize: 500,
   *   concurrency: 3,
   * })
   * ```
   */
  async batchInsert<TTable extends PgTable>(
    table: TTable,
    values: readonly InferInsertModel<TTable>[],
    options?: BatchOptions,
  ): Promise<void> {
    await this.batch(
      values,
      (chunk) => this._db.insert(table).values(chunk),
      options,
    );
  }

  /**
   * 按 ID 分片删除，每片生成一条 `DELETE ... WHERE id IN (...)`。
   *
   * @example
   * ```ts
   * await db.batchDelete(todos, todos.id, todoIds, { chunkSize: 500 })
   * ```
   */
  async batchDelete<TTable extends PgTable, TIdColumn extends PgColumn>(
    table: TTable,
    idColumn: TIdColumn,
    ids: readonly TIdColumn['_']['data'][],
    options?: BatchOptions,
  ): Promise<void> {
    await this.batch(
      ids,
      (chunk) => this._db.delete(table).where(inArray(idColumn, chunk)),
      options,
    );
  }

  /**
   * 按 ID 分片更新，每片生成一条 `UPDATE ... SET ... WHERE id IN (...)`。
   * 所有 ID 使用同一组更新值；不同记录需要不同值时请使用通用 `batch`。
   *
   * @example 批量完成 Todo
   * ```ts
   * await db.batchUpdate(
   *   todos,
   *   todos.id,
   *   todoIds,
   *   { completed: true, updatedAt: new Date() },
   *   { chunkSize: 500 },
   * )
   * ```
   */
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
        this._db.update(table).set(values).where(inArray(idColumn, chunk)),
      options,
    );
  }

  /**
   * 单表 Offset 分页，同时查询当前页数据和总数。
   *
   * 适合需要页码、总数和跳页能力的后台表格；不适合高频新增的数据流或深分页。
   *
   * @example
   * ```ts
   * const page = await db.paginate({
   *   table: todos,
   *   where: ilike(todos.title, `%${keyword}%`),
   *   orderCol: todos.updatedAt,
   *   order: 'desc',
   *   page: 2,
   *   size: 20,
   * })
   * // page = { items, total, page: 2, size: 20 }
   * ```
   */
  async paginate<TTable extends PgTable, T = InferSelectModel<TTable>>(opts: {
    table: TTable;
    where?: SQL;
    orderCol?: PgColumn;
    order?: 'asc' | 'desc';
    page: number;
    size: number;
    map?: (row: InferSelectModel<TTable>) => T;
  }): Promise<PageResult<T>> {
    const { table, where, orderCol, order = 'desc', page, size, map } = opts;
    const offset = (page - 1) * size;
    const orderExpr = orderCol
      ? order === 'asc'
        ? asc(orderCol)
        : desc(orderCol)
      : undefined;

    // PgTable cast satisfies drizzle's internal TableLikeHasEmptySelection constraint
    const t = table as PgTable;
    const baseQuery = this._db.select().from(t).where(where);

    const [rows, [{ total }]] = await Promise.all([
      (orderExpr ? baseQuery.orderBy(orderExpr) : baseQuery)
        .limit(size)
        .offset(offset),
      this._db.select({ total: count() }).from(t).where(where),
    ]);

    const items = map
      ? (rows as InferSelectModel<TTable>[]).map(map)
      : (rows as T[]);

    return { items, total: Number(total), page, size };
  }

  /**
   * 基于有序列组合的 Seek/Cursor 分页。
   *
   * `cursorColumns` 的顺序必须与数据库 ORDER BY、`cursorValues` 和复合索引一致。
   * 最后一列应当唯一，避免主排序列值相同时出现重复或遗漏。
   *
   * @example Todo 按更新时间倒序滚动，nanoid 只负责打破同一时间的排序冲突
   * ```ts
   * const result = await db.paginateCursor({
   *   table: todos,
   *   cursorColumns: [todos.updatedAt, todos.id],
   *   cursorValues: cursor
   *     ? [new Date(cursor.updatedAt), cursor.id]
   *     : undefined,
   *   getCursor: (row) => ({
   *     updatedAt: row.updatedAt.toISOString(),
   *     id: row.id,
   *   }),
   *   where: keyword ? ilike(todos.title, `%${keyword}%`) : undefined,
   *   order: 'desc',
   *   size: 20,
   * })
   * // result.nextCursor 为 null 时表示没有下一页
   * ```
   */
  async paginateCursor<
    TTable extends PgTable,
    TColumns extends CursorColumns,
    TCursor,
    T = InferSelectModel<TTable>,
  >(opts: {
    table: TTable;
    cursorColumns: TColumns;
    cursorValues?: CursorValues<TColumns>;
    getCursor: (row: InferSelectModel<TTable>) => TCursor;
    where?: SQL;
    order?: 'asc' | 'desc';
    size: number;
    map?: (row: InferSelectModel<TTable>) => T;
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
    } = opts;
    const cursorFilter = createCursorFilter(cursorColumns, cursorValues, order);
    const orderBy = createCursorOrder(cursorColumns, order);

    // 多取一条只用于判断是否还有下一页，避免额外执行 COUNT 查询。
    const rows = (await this._db
      .select()
      .from(table as PgTable)
      .where(and(where, cursorFilter))
      .orderBy(...orderBy)
      .limit(size + 1)) as InferSelectModel<TTable>[];
    const hasMore = rows.length > size;
    const pageRows = hasMore ? rows.slice(0, size) : rows;
    const lastRow = pageRows.at(-1);
    const items = map ? pageRows.map(map) : (pageRows as T[]);

    return {
      items,
      nextCursor: hasMore && lastRow ? getCursor(lastRow) : null,
    };
  }

  /**
   * 两阶段 cursor 分页：先在主表取 ID + cursor，再对当页 ID 执行 JOIN。
   * where 应仅引用主表，跨表过滤需改写为 EXISTS 子查询。
   *
   * 适合一对多 JOIN：如果直接对 JOIN 结果 LIMIT，限制的是联表行数，
   * 同一个主实体的多条子记录会错误占用分页数量。
   *
   * @example 先分页 Post，再加载当页 Post 及其 Comment
   * ```ts
   * const result = await db.paginateCursorDeferred({
   *   table: posts,
   *   idCol: posts.id,
   *   cursorColumns: [posts.createdAt, posts.id],
   *   cursorValues: cursor
   *     ? [new Date(cursor.createdAt), cursor.id]
   *     : undefined,
   *   getCursor: ([createdAt, id]) => ({
   *     createdAt: createdAt.toISOString(),
   *     id,
   *   }),
   *   size: 20,
   *   dataFn: (ids) => loadPostDetails(ids),
   *   getItemId: (item) => item.postId,
   * })
   * ```
   */
  async paginateCursorDeferred<
    TTable extends PgTable,
    TColumns extends CursorColumns,
    TCursor,
    TId,
    T,
  >(opts: {
    table: TTable;
    idCol: PgColumn;
    cursorColumns: TColumns;
    cursorValues?: CursorValues<TColumns>;
    getCursor: (values: CursorValues<TColumns>) => TCursor;
    where?: SQL;
    order?: 'asc' | 'desc';
    size: number;
    dataFn: (ids: TId[]) => Promise<T[]>;
    getItemId: (item: T) => TId;
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
    } = opts;
    const selection: Record<string, PgColumn> = { id: idCol };
    cursorColumns.forEach((column, index) => {
      selection[`cursor${index}`] = column;
    });
    const cursorFilter = createCursorFilter(cursorColumns, cursorValues, order);

    // Stage 1：只查主表 ID 和生成下一页 cursor 所需的列。
    const rows = await this._db
      .select(selection)
      .from(table as PgTable)
      .where(and(where, cursorFilter))
      .orderBy(...createCursorOrder(cursorColumns, order))
      .limit(size + 1);
    const hasMore = rows.length > size;
    const pageRows = hasMore ? rows.slice(0, size) : rows;
    const ids = pageRows.map((row) => row.id as TId);

    // Stage 2：只 JOIN 当前页主实体，避免全量 JOIN 后再分页。
    const loadedItems = ids.length > 0 ? await dataFn(ids) : [];

    // dataFn 可能返回一对多结果，因此按主 ID 分组，而不是只保留一条。
    const itemsById = new Map<TId, T[]>();
    loadedItems.forEach((item) => {
      const id = getItemId(item);
      const group = itemsById.get(id);
      if (group) group.push(item);
      else itemsById.set(id, [item]);
    });
    // SQL 的 IN 查询不保证返回顺序；按 Stage 1 的 ID 顺序重新展开结果。
    const items = ids.flatMap((id) => itemsById.get(id) ?? []);
    const lastRow = pageRows.at(-1);
    const lastCursorValues = lastRow
      ? (cursorColumns.map(
          (_, index) => lastRow[`cursor${index}`],
        ) as CursorValues<TColumns>)
      : undefined;

    return {
      items,
      nextCursor:
        hasMore && lastCursorValues ? getCursor(lastCursorValues) : null,
    };
  }

  /**
   * 多阶段分页查询（Deferred Join）
   *
   * Stage 1 — 只在主表上分页取 ID + COUNT（无 JOIN，极快）
   * Stage 2 — 用 ID 列表执行带 JOIN 的完整查询（只处理当页数据）
   *
   * 适用于含多个 LEFT JOIN 的复杂查询，避免全表 JOIN 后再分页。
   *
   * @example
   * ```ts
   * const page = await db.paginateDeferred({
   *   table: users,
   *   idCol: users.id,
   *   where: eq(users.enabled, true),
   *   orderCol: users.createdAt,
   *   page: 1,
   *   size: 20,
   *   dataFn: (ids) => loadUsersWithRoles(ids),
   * })
   * ```
   */
  async paginateDeferred<TTable extends PgTable, TId, T>(opts: {
    /** 主表（用于 COUNT 和取 ID） */
    table: TTable;
    /** 主键列（用于取分页 ID） */
    idCol: PgColumn;
    where?: SQL;
    orderCol?: PgColumn;
    order?: 'asc' | 'desc';
    page: number;
    size: number;
    /** 接收当页 ID 列表，返回完整数据（含 JOIN） */
    dataFn: (ids: TId[]) => Promise<T[]>;
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
    } = opts;
    const offset = (page - 1) * size;
    const orderExpr = orderCol
      ? order === 'asc'
        ? asc(orderCol)
        : desc(orderCol)
      : undefined;

    // PgTable cast satisfies drizzle's internal TableLikeHasEmptySelection constraint
    const t = table as PgTable;

    // Stage 1: 取 ID 列表 + 总数
    const idQuery = this._db.select({ id: idCol }).from(t).where(where);

    const [idRows, [{ total }]] = await Promise.all([
      (orderExpr ? idQuery.orderBy(orderExpr) : idQuery)
        .limit(size)
        .offset(offset),
      this._db.select({ total: count() }).from(t).where(where),
    ]);

    const ids = idRows.map((r) => r.id as TId);

    // Stage 2: 用 ID 做完整 JOIN 查询（当页为空时跳过）
    const items = ids.length > 0 ? await dataFn(ids) : [];

    return { items, total: Number(total), page, size };
  }
}
