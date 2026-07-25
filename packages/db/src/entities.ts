import { nanoid } from '@repo/shared'
import {
  boolean,
  pgTable,
  text,
  timestamp,
  varchar,
  snakeCase,
  numeric,
} from 'drizzle-orm/pg-core'

const commonColumns = {
  id: varchar('id')
    .primaryKey()
    .notNull()
    .$defaultFn(() => nanoid()),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}

export const users = snakeCase.table('users', {
  ...commonColumns,
  email: text('email').notNull().unique(),
  password: text('password').notNull(),
  realName: text('real_name'),
  resetPasswordToken: text('reset_password_token'),
  resetPasswordTokenExpiry: timestamp('reset_password_token_expiry'),
})

export const todos = snakeCase.table('todos', {
  ...commonColumns,
  title: text('title').notNull(),
  description: text('description'),
  completed: boolean('completed').notNull().default(false),
})
