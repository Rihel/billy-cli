import { users, type PageQueryResult } from '@repo/db'
import { Context, Effect, Layer } from 'effect'
import { eq, ilike, or } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import { Db, type DbError } from '../../../shared/database.capability.js'
import { User, type UserPageQuery } from '../domain.js'

export type UserRecord = typeof users.$inferSelect

export const toUser = (record: UserRecord): User => {
  const {
    password: _password,
    resetPasswordToken: _resetPasswordToken,
    resetPasswordTokenExpiry: _resetPasswordTokenExpiry,
    ...user
  } = record
  return new User(user)
}

export interface UserRepositoryApi {
  findById(id: string): Effect.Effect<UserRecord | undefined, DbError>
  findByEmail(email: string): Effect.Effect<UserRecord | undefined, DbError>
  findByResetToken(
    token: string,
  ): Effect.Effect<UserRecord | undefined, DbError>
  create(data: typeof users.$inferInsert): Effect.Effect<UserRecord, DbError>
  update(
    id: string,
    data: Partial<typeof users.$inferInsert>,
  ): Effect.Effect<UserRecord | undefined, DbError>
  remove(id: string): Effect.Effect<UserRecord | undefined, DbError>
  page(query: UserPageQuery): Effect.Effect<PageQueryResult<User>, DbError>
}

export class UserRepository extends Context.Tag('UserRepository')<
  UserRepository,
  UserRepositoryApi
>() {}

export const UserRepositoryLive = Layer.effect(
  UserRepository,
  Effect.gen(function* () {
    const db = yield* Db

    return {
      findById: (id) =>
        db.query((raw) =>
          raw
            .select()
            .from(users)
            .where(eq(users.id, id))
            .then(([user]) => user),
        ),
      findByEmail: (email) =>
        db.query((raw) =>
          raw
            .select()
            .from(users)
            .where(eq(users.email, email))
            .then(([user]) => user),
        ),
      findByResetToken: (token) =>
        db.query((raw) =>
          raw
            .select()
            .from(users)
            .where(eq(users.resetPasswordToken, token))
            .then(([user]) => user),
        ),
      create: (data) =>
        db.query((raw) =>
          raw
            .insert(users)
            .values(data)
            .returning()
            .then(([user]) => user),
        ),
      update: (id, data) =>
        db.query((raw) =>
          raw
            .update(users)
            .set(data)
            .where(eq(users.id, id))
            .returning()
            .then(([user]) => user),
        ),
      remove: (id) =>
        db.query((raw) =>
          raw
            .delete(users)
            .where(eq(users.id, id))
            .returning()
            .then(([user]) => user),
        ),
      page: ({ page, size, keyword, orderBy = 'createdAt', order = 'desc' }) =>
        db.pageQuery({
          table: users,
          where: keyword
            ? or(
                ilike(users.email, `%${keyword}%`),
                ilike(users.realName, `%${keyword}%`),
              )
            : undefined,
          orderCol: users[orderBy] as PgColumn,
          order,
          page,
          size,
          map: toUser,
        }),
    } satisfies UserRepositoryApi
  }),
)
