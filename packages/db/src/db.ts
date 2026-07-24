import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres'

export const createDb = (url: string): NodePgDatabase => {
  const client = drizzle({
    connection: url,
  })

  return client
}
