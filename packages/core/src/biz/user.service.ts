import { Context, Effect, Layer } from 'effect'
import { users } from '@repo/db'
import {
  AppErrorCodes,
  CreateUserDto,
  GetUserDetailDto,
  PageQueryUserDto,
  RemoveUserDto,
  ResetUserPasswordDto,
  UpdateUserDto,
} from '@repo/shared'
import { eq, ilike, or } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { z } from 'zod'
import { AppError, makeError } from '../errors.js'
import { DbService } from '../infra/db.service.js'
import { LoggerService } from '../infra/logger.service.js'
import { PasswordService } from '../infra/password.service.js'

type UserRow = typeof users.$inferSelect
type SafeUser = Omit<
  UserRow,
  'password' | 'resetPasswordToken' | 'resetPasswordTokenExpiry'
>

function sanitizeUser(user: UserRow): SafeUser {
  const {
    password: _p,
    resetPasswordToken: _r,
    resetPasswordTokenExpiry: _e,
    ...safe
  } = user
  return safe
}

export interface IUserService {
  create(
    input: z.infer<typeof CreateUserDto>,
  ): Effect.Effect<SafeUser, AppError>
  pageQuery(
    input: z.infer<typeof PageQueryUserDto>,
  ): Effect.Effect<any, AppError>
  detail(
    input: z.infer<typeof GetUserDetailDto>,
  ): Effect.Effect<SafeUser, AppError>
  update(
    input: z.infer<typeof UpdateUserDto>,
  ): Effect.Effect<SafeUser, AppError>
  remove(
    input: z.infer<typeof RemoveUserDto>,
  ): Effect.Effect<{ success: true }, AppError>
  resetPassword(
    input: z.infer<typeof ResetUserPasswordDto>,
  ): Effect.Effect<{ success: true }, AppError>
}

export class UserService extends Context.Tag('UserService')<
  UserService,
  IUserService
>() {}

export const UserServiceLive = Layer.effect(
  UserService,
  Effect.gen(function* () {
    const db = yield* DbService
    const logger = yield* LoggerService
    const passwordService = yield* PasswordService

    return {
      create: (input) =>
        Effect.gen(function* () {
          logger.log('create', { email: input.email })
          const hashed = yield* passwordService.hash(input.password)
          const user = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const [existing] = yield* tx.query((raw) =>
                raw.select().from(users).where(eq(users.email, input.email)),
              )
              if (existing)
                return yield* Effect.fail(makeError(AppErrorCodes.EmailTaken))
              const [newUser] = yield* tx.query((raw) =>
                raw
                  .insert(users)
                  .values({ ...input, password: hashed })
                  .returning(),
              )
              return newUser
            }),
          )
          logger.log('created', { id: user.id })
          return sanitizeUser(user)
        }),

      pageQuery: (input) =>
        Effect.gen(function* () {
          const { page, size, keyword, orderBy, order } = input
          return yield* db.pageQuery({
            table: users,
            where: keyword
              ? or(
                  ilike(users.email, `%${keyword}%`),
                  ilike(users.realName, `%${keyword}%`),
                )
              : undefined,
            orderCol: users[orderBy as keyof typeof users] as PgColumn,
            order,
            page,
            size,
            map: (u) => sanitizeUser(u as UserRow),
          })
        }),

      detail: (input) =>
        Effect.gen(function* () {
          const [user] = yield* db.query((raw) =>
            raw.select().from(users).where(eq(users.id, input.userId)),
          )
          if (!user)
            return yield* Effect.fail(makeError(AppErrorCodes.UserNotFound))
          return sanitizeUser(user)
        }),

      update: (input) =>
        Effect.gen(function* () {
          logger.log('update', { userId: input.userId })
          const { userId, ...fields } = input
          const [user] = yield* db.query((raw) =>
            raw
              .update(users)
              .set(fields)
              .where(eq(users.id, userId))
              .returning(),
          )
          if (!user)
            return yield* Effect.fail(makeError(AppErrorCodes.UserNotFound))
          return sanitizeUser(user)
        }),

      remove: (input) =>
        Effect.gen(function* () {
          const [user] = yield* db.query((raw) =>
            raw.delete(users).where(eq(users.id, input.userId)).returning(),
          )
          if (!user)
            return yield* Effect.fail(makeError(AppErrorCodes.UserNotFound))
          logger.log('removed', { userId: input.userId })
          return { success: true as const }
        }),

      resetPassword: (input) =>
        Effect.gen(function* () {
          logger.log('resetPassword', { userId: input.userId })
          const hashed = yield* passwordService.hash(input.password)
          const [user] = yield* db.query((raw) =>
            raw
              .update(users)
              .set({ password: hashed })
              .where(eq(users.id, input.userId))
              .returning(),
          )
          if (!user)
            return yield* Effect.fail(makeError(AppErrorCodes.UserNotFound))
          return { success: true as const }
        }),
    }
  }),
)
