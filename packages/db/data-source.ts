import 'dotenv/config'
import { DataSource } from 'typeorm'
import path from 'node:path'
const __dirname = path.dirname(new URL(import.meta.url).pathname)

/**
 * TypeORM CLI（migration:generate / migration:run）使用的 DataSource。
 * 由 tsx 加载（见 package.json scripts），可直接引用 .ts 源码实体。
 */
export default new DataSource({
  type: 'postgres',
  url: process.env.DB_URL!,
  entities: [__dirname + '/src/entities/*.{js,ts}'],
  migrations: [__dirname + '/migrations/*.{js,ts}'],
  synchronize: false,
  logging: true,
})
