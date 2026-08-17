import { DataSource, DataSourceOptions } from 'typeorm'
import { UserEntity } from './entities/user-entity'
import { TodoEntity } from './entities/todo-entity'
import { AdminEntity } from './entities/admin-entity'
import {
  addTransactionalDataSource,
  initializeTransactionalContext,
} from 'typeorm-transactional'

export const createDb = (options: DataSourceOptions): DataSource => {
  // 库要求 initializeTransactionalContext 必须先于 addTransactionalDataSource 执行：
  // 未初始化时访问 dataSource.manager / repo.manager 会抛
  // "No storage driver defined ... please call initializeTransactionalContext()"。
  // 幂等，重复调用安全。
  initializeTransactionalContext()
  const db = new DataSource({
    type: 'postgres',
    entities: [UserEntity, TodoEntity, AdminEntity],
    ...options,
  })
  return addTransactionalDataSource(db)
}
