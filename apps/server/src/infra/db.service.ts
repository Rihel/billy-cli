import { Injectable } from '@nestjs/common';
import { createDb } from '@repo/db';
import { InferSelectModel, asc, count, desc, SQL } from 'drizzle-orm';
import { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { appConfig } from '../config.js';

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

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

  /** 单表分页查询 */
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
   * 多阶段分页查询（Deferred Join）
   *
   * Stage 1 — 只在主表上分页取 ID + COUNT（无 JOIN，极快）
   * Stage 2 — 用 ID 列表执行带 JOIN 的完整查询（只处理当页数据）
   *
   * 适用于含多个 LEFT JOIN 的复杂查询，避免全表 JOIN 后再分页。
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
