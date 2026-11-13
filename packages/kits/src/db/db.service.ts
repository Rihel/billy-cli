import type {
  EntityManager,
  EntityTarget,
  FindOptionsWhere,
  ObjectLiteral,
  QueryDeepPartialEntity,
  SelectQueryBuilder,
} from 'typeorm'
import { Inject, Injectable } from '@nestjs/common'
import { Db } from './db.js'
import { getAuditUser } from './audit-subscriber.js'
import {
  batch as runBatch,
  batchDelete as runBatchDelete,
  batchInsert as runBatchInsert,
  batchSave as runBatchSave,
  batchUpsert as runBatchUpsert,
  resolveBatchConcurrency,
  type BatchDeleteOptions,
  type BatchOptions,
} from './batch.js'
import { safeDelete as runSafeDelete } from './safe-delete.js'
import { getFullSqlStatement as buildFullSql } from './sql.js'
import {
  cursorPageWith as runCursorPageWith,
  cursorPageWithDeferred as runCursorPageWithDeferred,
  pageWith as runPageWith,
  pageWithDeferred as runPageWithDeferred,
  type CursorPageOptions,
  type CursorResult,
  type DeferredCursorOptions,
  type DeferredPageOptions,
  type PageResult,
} from './pagination.js'
import type { AuditEntity } from './audit-entity.js'

/** 覆写默认 manager / 操作人的公共参数（事务内务必显式传 `manager`） */
export interface DbOperationOptions {
  /** 显式指定 manager；不传则用 DataSource 根 manager */
  manager?: EntityManager
  /** 显式指定操作人；不传则读审计钩子 `getAuditUser()` */
  operatorId?: string
}

/**
 * 数据库操作统一入口（注入式）。
 *
 * 与 `db/pagination.ts` / `db/batch.ts` / `db/safe-delete.ts` / `db/sql.ts` 的纯函数是
 * **同一套实现**：纯函数是可直接单测的内核，本类把它们接进 Nest 容器，
 * 统一业务侧的调用入口，并补上「到处都要传」的默认值：
 *
 * - **默认 manager**：`this.manager` 取 `Db` 的 DataSource 根 manager；
 * - **默认操作人**：`this.operatorId` 读 `getAuditUser()`（即 `setAuditUserProvider`
 *   挂的钩子，与 `AuditSubscriber` 同源），业务侧不必把 userId 一路透传下来。
 *
 * **只依赖 `Db`，不注入 AppLogger**：本类不产生任何运维日志（连接 / 释放是 `Db` 的职责），
 * 唯一像「日志」的 SQL 打印其实是调用方的排障动作——而调用方（repository / service）
 * 按工程约定本就注入了 `AppLogger`，一行 `this.logger.debug(getFullSqlStatement(builder))` 即可。
 * 故这里只提供纯函数的 `getFullSqlStatement`，不代打日志。
 *
 * 方法面与 rihel-base 的 `DBService` 对齐：分页（`pageWith` / `pageWithDeferred` /
 * `cursorPageWith` / `cursorPageWithDeferred`）、批量（`batch` / `batchInsert` / `batchSave` /
 * `batchUpsert` / `batchDelete`）、软删（`safeDelete`）、SQL（`getFullSqlStatement`）。
 * 命名上 `pageWithDeferred` 即 rihel 的 `multiplePageWith`（两阶段：先主键分页再回表），
 * 且 billy 多出游标（cursor）两种，能力是超集；
 * 唯一未搬的是 rihel 的 `printSql`——它的方法体只有一次 logger 调用，去掉日志依赖即无内容。
 *
 * 放置：通用数据访问能力 → `packages/kits/src/db/`，由 `DbModule` 装配（`@Global`）。
 *
 * **事务注意**：`batch*` / `safeDelete` 在**事务内**必须显式传事务的 `manager`
 * （`@Transactional()` 方法里用调用方 manager），否则会落到根 manager 上脱离事务。
 */
@Injectable()
export class DbService {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** 默认 manager：DataSource 根 manager（DataSource 尚未 initialize 时访问会抛错） */
  get manager(): EntityManager {
    return this.db.dataSource.manager
  }

  /** 当前操作人：读审计钩子，未挂载时回落 `'system'`（与 `AuditSubscriber` 同源） */
  get operatorId(): string {
    return getAuditUser()
  }

  /**
   * 解析实际生效的 manager。
   *
   * 传了就用传的（事务内就该传事务 manager）；没传时**退回根 manager 而不是 undefined**，
   * 以便 `resolveBatchConcurrency` 仍能感知事务状态、把并发降为 1。
   */
  private resolveManager(manager?: EntityManager): EntityManager {
    return manager ?? this.manager
  }

  // ── 分页 ────────────────────────────────────────────────────────────

  /** 页码分页（`LIMIT/OFFSET`），返回 `{ data, total }`。 */
  async pageWith<T extends ObjectLiteral>(
    builder: SelectQueryBuilder<T>,
    page: number,
    size: number,
  ): Promise<PageResult<T>> {
    return runPageWith(builder, page, size)
  }

  /** 两阶段页码分页：先主键分页，再按主键回表加载详情（复杂联表 / 重聚合场景）。 */
  async pageWithDeferred<T extends ObjectLiteral>(
    options: DeferredPageOptions<T>,
  ): Promise<PageResult<T>> {
    return runPageWithDeferred(options)
  }

  /** 游标分页（复合键 seek），适合无限滚动与持续新增的数据流。 */
  async cursorPageWith<T extends ObjectLiteral>(
    builder: SelectQueryBuilder<T>,
    options: CursorPageOptions<T>,
  ): Promise<CursorResult<T>> {
    return runCursorPageWith(builder, options)
  }

  /** 两阶段游标分页：先定位主键与 cursor，再回表查当页数据。 */
  async cursorPageWithDeferred<T extends ObjectLiteral>(
    builder: SelectQueryBuilder<T>,
    options: DeferredCursorOptions<T>,
  ): Promise<CursorResult<T>> {
    return runCursorPageWithDeferred(builder, options)
  }

  // ── 批量写入 / 删除 ─────────────────────────────────────────────────

  /**
   * 通用分片处理：按 `chunkSize` 切片、以 `concurrency` 并发调用 `handler`。
   * 并发度会按有效 manager 的事务状态自动降为 1。
   */
  async batch<T>(
    items: T[],
    handler: (chunk: T[]) => Promise<unknown>,
    options: BatchOptions = {},
    manager?: EntityManager,
  ): Promise<void> {
    await runBatch(items, handler, {
      ...options,
      concurrency: resolveBatchConcurrency(this.resolveManager(manager), options.concurrency),
    })
  }

  /** 分片批量插入：不触发实体钩子、不级联，适合无关联的纯数据写入。 */
  async batchInsert<T extends ObjectLiteral>(
    entityType: EntityTarget<T>,
    data: QueryDeepPartialEntity<T>[],
    options: BatchOptions = {},
    manager?: EntityManager,
  ): Promise<void> {
    await runBatchInsert(this.resolveManager(manager), entityType, data, options)
  }

  /** 分片批量 save：触发实体钩子与级联，适合有关联关系的写入（慢于 batchInsert）。 */
  async batchSave<T extends ObjectLiteral>(
    data: T[],
    options: BatchOptions = {},
    manager?: EntityManager,
  ): Promise<void> {
    await runBatchSave(this.resolveManager(manager), data, options)
  }

  /** 分片批量 upsert：`INSERT ... ON CONFLICT DO UPDATE`，适合导入 / 同步。 */
  async batchUpsert<T extends ObjectLiteral>(
    entityType: EntityTarget<T>,
    data: QueryDeepPartialEntity<T>[],
    conflictPaths: string[],
    options: BatchOptions = {},
    manager?: EntityManager,
  ): Promise<void> {
    await runBatchUpsert(this.resolveManager(manager), entityType, data, conflictPaths, options)
  }

  /** 分片批量删除：先按 `selectIds` 取出目标主键，再分片 `DELETE ... WHERE id IN (...)`。 */
  async batchDelete<T extends ObjectLiteral>(
    entityType: EntityTarget<T>,
    options: BatchDeleteOptions<T>,
    manager?: EntityManager,
  ): Promise<void> {
    await runBatchDelete(this.resolveManager(manager), entityType, options)
  }

  /** 软删并记录操作人（先写 `deletedBy` 再软删）；操作人默认取当前请求身份。 */
  async safeDelete<T extends AuditEntity>(
    entityType: EntityTarget<T>,
    where: FindOptionsWhere<T>,
    options: DbOperationOptions = {},
  ): Promise<void> {
    await runSafeDelete(
      this.resolveManager(options.manager),
      entityType,
      where,
      options.operatorId ?? this.operatorId,
    )
  }

  // ── SQL 调试 ────────────────────────────────────────────────────────

  /**
   * 还原成可直接粘进 psql 的完整 SQL（不输出，仅返回）。
   *
   * 要打日志由调用方自己决定级别与上下文：
   * `this.logger.debug(this.dbService.getFullSqlStatement(builder))`。
   */
  getFullSqlStatement<T extends ObjectLiteral>(builder: SelectQueryBuilder<T>): string {
    return buildFullSql(builder)
  }
}
