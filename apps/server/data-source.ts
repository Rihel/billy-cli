import 'dotenv/config'
import { DataSource } from 'typeorm'
import path from 'node:path'
const __dirname = path.dirname(new URL(import.meta.url).pathname)

/**
 * TypeORM CLI（migration:generate / migration:run）使用的 DataSource。
 * 由 tsx 加载（见 package.json scripts），可直接引用 .ts 源码实体。
 * 实体与迁移均自管于 apps/server/src/database/ 下。
 */
export default new DataSource({
  type: 'postgres',
  url: process.env.DB_URL!,
  entities: [__dirname + '/src/database/entities/*.{js,ts}'],
  migrations: [__dirname + '/src/database/migrations/*.{js,ts}'],
  synchronize: false,
  logging: true,
})
