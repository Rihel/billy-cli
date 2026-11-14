import { config } from 'dotenv'
import { existsSync } from 'node:fs'

for (const file of ['.env', '../../apps/main/.env', '../../apps/agent-runtime/.env']) {
  if (existsSync(file)) {
    config({ path: file })
    break
  }
}
import { DataSource } from 'typeorm'
import { DB_ENTITIES, DB_MIGRATIONS } from '@repo/db'

/**
 * TypeORM CLI（migration:generate / migration:run）使用的 DataSource。
 *
 * 实体与迁移的**事实源在 `@repo/db`**：server / gateway / 将来的新 app 共用同一份，
 * 不再各自维护 `src/database/`。CLI 通过 tsx 直接加载包产物（先 `pnpm --filter @repo/db build`）。
 */
export default new DataSource({
  type: 'postgres',
  url: process.env.DB_URL!,
  entities: [...DB_ENTITIES],
  migrations: [...DB_MIGRATIONS],
  synchronize: false,
  logging: true,
})
