import 'dotenv/config'
import { DataSource } from 'typeorm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Windows 下 `new URL(...).pathname` 会带前导 `/`（`/D:/...`），glob 匹配不到任何文件；
// fileURLToPath 才是跨平台写法（迁移此前因此一直「No migrations are pending」）。
const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
