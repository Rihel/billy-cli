import {
  createDb,
  cursorQuery as runCursorQuery,
  cursorQueryDeferred as runCursorQueryDeferred,
  pageQuery as runPageQuery,
  pageQueryDeferred as runPageQueryDeferred,
  type CursorColumns,
  type CursorQueryDeferredOptions,
  type CursorQueryOptions,
  type CursorQueryResult,
  type PageQueryDeferredOptions,
  type PageQueryOptions,
  type PageQueryResult,
} from '@repo/db'
import { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { InferSelectModel } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { Cause, Config, Context, Data, Effect, Exit, Layer } from 'effect'
import { tryPromise } from './effect-adapters.js'

export type {
  CursorColumns,
  CursorQueryDeferredOptions,
  CursorQueryOptions,
  CursorQueryResult,
  CursorValues,
  PageQueryDeferredOptions,
  PageQueryOptions,
  PageQueryResult,
} from '@repo/db'

/** 数据库或 Drizzle 自身产生的基础设施错误，保留原始异常便于日志与诊断。 */
export class DbError extends Data.TaggedError('DbError')<{
  cause: unknown
}> {}

/**
 * 仅在 Effect 与 Drizzle 的事务边界内部使用。
 *
 * Drizzle 通过事务回调的 Promise 是否 reject 来决定回滚，而
 * runPromiseExit 会把 Effect 失败编码为正常 resolve 的 Exit.Failure。
 * 因此需要用该类型暂时包装完整 Cause 并抛出，让 Drizzle 感知失败；
 * 事务结束后再恢复原始 Cause，避免把业务错误 E 错误地包装成 DbError。
 */
class TransactionFailure<E> extends Data.TaggedError('TransactionFailure')<{
  cause: Cause.Cause<E>
}> {}

// ── IDb: fully Effect-native interface ───────────────────────────────────────

/**
 * 事务回调内可用的数据库能力。
 * 运行时对象同样不包含 transaction，从类型和实现两层禁止隐式嵌套事务。
 */
export interface TransactionDb {
  /** 执行 Drizzle 查询；数据库异常统一进入 DbError 错误通道。 */
  query<T>(fn: (raw: NodePgDatabase) => Promise<T>): Effect.Effect<T, DbError>

  /** 两阶段 Offset 分页，详情阶段可执行任意连表查询。 */
  pageQuery<TTable extends PgTable, T = InferSelectModel<TTable>>(
    opts: PageQueryOptions<TTable, T>,
  ): Effect.Effect<PageQueryResult<T>, DbError>

  /** 多阶段 Offset 分页：先分页主键，再加载详情。 */
  pageQueryDeferred<TTable extends PgTable, TId, T>(
    opts: PageQueryDeferredOptions<TTable, TId, T>,
  ): Effect.Effect<PageQueryResult<T>, DbError>

  /** Cursor-based pagination (implementation from kits). */
  cursorQuery<
    TTable extends PgTable,
    TColumns extends CursorColumns,
    TCursor,
    T = InferSelectModel<TTable>,
  >(
    opts: CursorQueryOptions<TTable, TColumns, TCursor, T>,
  ): Effect.Effect<CursorQueryResult<T, TCursor>, DbError>

  /** 多阶段 Cursor 分页：先定位主键，再加载详情。 */
  cursorQueryDeferred<
    TTable extends PgTable,
    TColumns extends CursorColumns,
    TCursor,
    TId,
    T,
  >(
    opts: CursorQueryDeferredOptions<TTable, TColumns, TCursor, TId, T>,
  ): Effect.Effect<CursorQueryResult<T, TCursor>, DbError>
}

export interface IDb extends TransactionDb {
  /**
   * 在数据库事务中运行 Effect 回调。
   * 回调的业务错误 E 会触发回滚并原样保留；数据库异常则转换为 DbError。
   */
  transaction<T, E>(
    fn: (tx: TransactionDb) => Effect.Effect<T, E>,
  ): Effect.Effect<T, E | DbError>
}

export class Db extends Context.Tag('Db')<Db, IDb>() {}

const buildDbOperations = (raw: NodePgDatabase): TransactionDb => {
  // 将 Drizzle 的 Promise 异常提升到 Effect 的类型化错误通道。
  const query = <T>(fn: (raw: NodePgDatabase) => Promise<T>) =>
    tryPromise(
      () => fn(raw),
      (cause) => new DbError({ cause }),
    )

  const fromDbPromise = <T>(operation: () => Promise<T>) =>
    tryPromise(operation, (cause) => new DbError({ cause }))

  return {
    query,
    pageQuery: (opts) => fromDbPromise(() => runPageQuery(raw, opts)),
    pageQueryDeferred: (opts) =>
      fromDbPromise(() => runPageQueryDeferred(raw, opts)),
    cursorQuery: (opts) => fromDbPromise(() => runCursorQuery(raw, opts)),
    cursorQueryDeferred: (opts) =>
      fromDbPromise(() => runCursorQueryDeferred(raw, opts)),
  }
}

const buildDb = (raw: NodePgDatabase): IDb => {
  const transaction = <T, E>(
    fn: (tx: TransactionDb) => Effect.Effect<T, E>,
  ): Effect.Effect<T, E | DbError> =>
    Effect.tryPromise<T, TransactionFailure<E> | DbError>({
      try: () =>
        raw.transaction(async (rawTx) => {
          // 只暴露绑定到 rawTx 的查询能力，确保共享事务且无法再次开启事务。
          const effect = fn(buildDbOperations(rawTx))

          // 保留 Fail、Die、Interrupt 以及组合 Cause，先不压缩成单个错误。
          const exit = await Effect.runPromiseExit(effect)
          if (Exit.isFailure(exit)) {
            // 必须在 Drizzle 的事务回调返回前抛出，外层再抛已来不及回滚。
            throw new TransactionFailure({ cause: exit.cause })
          }
          return exit.value
        }),
      // 内部事务失败保持可识别；只有数据库/Drizzle 异常才转换为 DbError。
      catch: (cause) =>
        cause instanceof TransactionFailure ? cause : new DbError({ cause }),
    }).pipe(
      // 回滚完成后恢复原始 Cause，使调用方仍能得到业务错误 E 及完整失败语义。
      Effect.catchTag('TransactionFailure', ({ cause }) =>
        Effect.failCause(cause),
      ),
    )

  return {
    ...buildDbOperations(raw),
    transaction,
  }
}

const createIDb = Effect.gen(function* () {
  const url = yield* Config.string('DB_URL').pipe(
    Config.withDescription('Database connection URL'),
    Config.withDefault('postgres://postgres:postgres@localhost:5432/postgres'),
  )
  const { db: raw } = yield* Effect.acquireRelease(
    Effect.sync(() => createDb(url)),
    // 数据库连接与当前 Effect Scope 生命周期绑定，Scope 结束时保证释放。
    ({ close }) => Effect.promise(() => close()),
  )

  return buildDb(raw)
})

export const DbLive = Layer.scoped(Db, createIDb)
