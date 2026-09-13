import { DataSource, type DataSourceOptions } from 'typeorm'
import {
  addTransactionalDataSource,
  initializeTransactionalContext,
} from 'typeorm-transactional'

/** 本工程固定 PostgreSQL：从 DataSourceOptions 联合类型中取出 PG 分支 */
export type PostgresDataSourceOptions = Extract<
  DataSourceOptions,
  { type: 'postgres' }
>

/**
 * 创建并注册 TypeORM DataSource（kits 的 Db 门面内部使用）。
 *
 * `type` 由本工厂固定为 postgres，调用方无需（也不应）再传 ——
 * DataSourceOptions 是按 driver 判别的联合类型，若由调用方传 type，spread 后无法正确判别。
 */
export const createDb = (
  options: Omit<PostgresDataSourceOptions, 'type'>,
): DataSource => {
  // 库要求 initializeTransactionalContext 必须先于 addTransactionalDataSource 执行：
  // 未初始化时访问 dataSource.manager / repo.manager 会抛
  // "No storage driver defined ... please call initializeTransactionalContext()"。
  // 幂等，重复调用安全。
  initializeTransactionalContext()
  const db = new DataSource({
    ...options,
    type: 'postgres',
  } as PostgresDataSourceOptions)
  return addTransactionalDataSource(db)
}
