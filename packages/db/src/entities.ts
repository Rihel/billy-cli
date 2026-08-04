import { nanoid } from '@repo/shared'
import {
  boolean,
  pgTable,
  text,
  timestamp,
  varchar,
  snakeCase,
  numeric,
  index,
} from 'drizzle-orm/pg-core'

const commonColumns = {
  id: varchar('id')
    .primaryKey()
    .notNull()
    .$defaultFn(() => nanoid()),
  createdAt: timestamp('created_at', { precision: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { precision: 3 }).notNull().defaultNow(),
}

export const users = snakeCase.table('users', {
  ...commonColumns,
  email: text('email').notNull().unique(),
  password: text('password').notNull(),
  realName: text('real_name'),
  avatar: text('avatar'),
  resetPasswordToken: text('reset_password_token'),
  resetPasswordTokenExpiry: timestamp('reset_password_token_expiry'),
})

export const todos = snakeCase.table(
  'todos',
  {
    ...commonColumns,
    title: text('title').notNull(),
    description: text('description'),
    completed: boolean('completed').notNull().default(false),
  },
  (table) => [
    index('todos_updated_at_id_idx').on(
      table.updatedAt.desc(),
      table.id.desc(),
    ),
  ],
)
