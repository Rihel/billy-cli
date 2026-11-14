import { config } from 'dotenv'
import { existsSync } from 'node:fs'
import { DataSource } from 'typeorm'
import { DB_ENTITIES, DB_MIGRATIONS } from '@repo/db'

for (const file of ['.env', '../../apps/main/.env', '../../apps/agent-runtime/.env']) {
  if (existsSync(file)) {
    config({ path: file })
    break
  }
}

export default new DataSource({
  type: 'postgres',
  url: process.env.DB_URL,
  entities: [...DB_ENTITIES],
  migrations: [...DB_MIGRATIONS],
  synchronize: false,
  logging: true,
})
