import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

export interface DbInstance {
  db: NodePgDatabase
  close: () => Promise<void>
}

export const createDb = (url: string): DbInstance => {
  const pool = new Pool({ connectionString: url })
  const db = drizzle({ client: pool })
  return {
    db,
    close: () => pool.end(),
  }
}
