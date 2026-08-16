import { DataSource, DataSourceOptions } from 'typeorm'
import { UserEntity } from './entities/user-entity'
import { TodoEntity } from './entities/todo-entity'

export const createDb = (options: DataSourceOptions): DataSource =>
  new DataSource({
    type: 'postgres',
    entities: [UserEntity, TodoEntity],
    ...options,
  })
