import { Context, Effect, Layer } from 'effect'
import { ConfigService } from '../infra/config.service.js'
import { users } from '@repo/db'
import {
  AppErrorCodes,
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  UpdateInfoDto,
  dayjs,
  nanoid,
} from '@repo/shared'
import { eq } from 'drizzle-orm'
import type { z } from 'zod'
import { AppError, makeError } from '../errors.js'
import { DbService } from '../infra/db.service.js'
import { LoggerService } from '../infra/logger.service.js'
import { JwtService } from '../infra/jwt.service.js'
import { PasswordService } from '../infra/password.service.js'
import { parseInput } from '../effects/index.js'
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

// ── Service interface ─────────────────────────────────────────────────────────

export interface IAuthService {
  register(
    input: z.infer<typeof RegisterDto>,
  ): Effect.Effect<{ token: string; user: SafeUser }, AppError>
  login(
    input: z.infer<typeof LoginDto>,
  ): Effect.Effect<{ token: string; user: SafeUser }, AppError>
  forgotPassword(
    input: z.infer<typeof ForgotPasswordDto>,
  ): Effect.Effect<{ success: true; token?: string }, AppError>
  resetPassword(
    input: z.infer<typeof ResetPasswordDto>,
  ): Effect.Effect<{ success: true }, AppError>
  getMe(userId: string): Effect.Effect<SafeUser, AppError>
  updateInfo(
    userId: string,
    input: z.infer<typeof UpdateInfoDto>,
  ): Effect.Effect<SafeUser, AppError>
  changePassword(
    userId: string,
    input: z.infer<typeof ChangePasswordDto>,
  ): Effect.Effect<{ success: true }, AppError>
  verifyToken(token: string): Effect.Effect<string, AppError>
}

export class AuthService extends Context.Tag('AuthService')<
  AuthService,
  IAuthService
>() {}

// ── Live implementation ───────────────────────────────────────────────────────

export const AuthServiceLive = Layer.effect(
  AuthService,
  Effect.gen(function* () {
    const { auth } = yield* ConfigService
    const ttl = auth.resetPasswordTokenTtlMinutes
    const db = yield* DbService
    const logger = yield* LoggerService
    const jwt = yield* JwtService
    const passwordService = yield* PasswordService

    return {
      register: (input) =>
        parseInput(RegisterDto, input).pipe(
          Effect.flatMap((parsed) =>
            Effect.gen(function* () {
              const hashed = yield* passwordService.hash(parsed.password)
              const user = yield* db.transaction((tx) =>
                Effect.gen(function* () {
                  const [existing] = yield* tx.query((raw) =>
                    raw
                      .select()
                      .from(users)
                      .where(eq(users.email, parsed.email)),
                  )
                  if (existing)
                    return yield* Effect.fail(
                      makeError(AppErrorCodes.EmailTaken),
                    )
                  const [newUser] = yield* tx.query((raw) =>
                    raw
                      .insert(users)
                      .values({ ...parsed, password: hashed })
                      .returning(),
                  )
                  return newUser
                }),
              )
              return {
                token: jwt.sign({ sub: user.id }),
                user: sanitizeUser(user),
              }
            }),
          ),
          Effect.tap((result) =>
            Effect.sync(() =>
              logger.log('auth.registered', { id: result.user.id }),
            ),
          ),
        ),

      login: (input) =>
        parseInput(LoginDto, input).pipe(
          Effect.flatMap((parsed) =>
            Effect.gen(function* () {
              const [user] = yield* db.query((raw) =>
                raw.select().from(users).where(eq(users.email, parsed.email)),
              )
              if (!user)
                return yield* Effect.fail(
                  makeError(AppErrorCodes.EmailNotFound),
                )
              const valid = yield* passwordService.verify(
                parsed.password,
                user.password,
              )
              if (!valid)
                return yield* Effect.fail(
                  makeError(AppErrorCodes.InvalidCredentials),
                )
              return {
                token: jwt.sign({ sub: user.id }),
                user: sanitizeUser(user),
              }
            }),
          ),
          Effect.tap((result) =>
            Effect.sync(() => logger.log('auth.login', { id: result.user.id })),
          ),
        ),

      forgotPassword: (input) =>
        parseInput(ForgotPasswordDto, input).pipe(
          Effect.flatMap((parsed) =>
            Effect.gen(function* () {
              const token = nanoid(32)
              const expiry = dayjs().add(ttl, 'minute').toDate()
              const updated = yield* db.transaction((tx) =>
                Effect.gen(function* () {
                  const [user] = yield* tx.query((raw) =>
                    raw
                      .select()
                      .from(users)
                      .where(eq(users.email, parsed.email)),
                  )
                  if (!user) return null
                  yield* tx.query((raw) =>
                    raw
                      .update(users)
                      .set({
                        resetPasswordToken: token,
                        resetPasswordTokenExpiry: expiry,
                      })
                      .where(eq(users.id, user.id)),
                  )
                  return user
                }),
              )
              return {
                success: true as const,
                ...(updated ? { token } : {}),
              }
            }),
          ),
          Effect.tap((result) =>
            Effect.sync(() =>
              result.token
                ? logger.log('auth.forgotPassword.tokenGenerated')
                : logger.warn('auth.forgotPassword.userNotFound'),
            ),
          ),
        ),

      resetPassword: (input) =>
        parseInput(ResetPasswordDto, input).pipe(
          Effect.flatMap((parsed) =>
            Effect.gen(function* () {
              const hashed = yield* passwordService.hash(parsed.password)
              yield* db.transaction((tx) =>
                Effect.gen(function* () {
                  const [user] = yield* tx.query((raw) =>
                    raw
                      .select()
                      .from(users)
                      .where(eq(users.resetPasswordToken, parsed.token)),
                  )
                  if (!user)
                    return yield* Effect.fail(
                      makeError(AppErrorCodes.InvalidResetToken),
                    )
                  if (
                    !user.resetPasswordTokenExpiry ||
                    dayjs().isAfter(user.resetPasswordTokenExpiry)
                  ) {
                    return yield* Effect.fail(
                      makeError(AppErrorCodes.ExpiredResetToken),
                    )
                  }
                  yield* tx.query((raw) =>
                    raw
                      .update(users)
                      .set({
                        password: hashed,
                        resetPasswordToken: null,
                        resetPasswordTokenExpiry: null,
                      })
                      .where(eq(users.id, user.id)),
                  )
                }),
              )
              return { success: true as const }
            }),
          ),
        ),

      getMe: (userId) =>
        Effect.gen(function* () {
          const [user] = yield* db.query((raw) =>
            raw.select().from(users).where(eq(users.id, userId)),
          )
          if (!user)
            return yield* Effect.fail(
              makeError(AppErrorCodes.Unauthorized, '用户不存在'),
            )
          return sanitizeUser(user)
        }),

      updateInfo: (userId, input) =>
        parseInput(UpdateInfoDto, input).pipe(
          Effect.flatMap((parsed) =>
            Effect.gen(function* () {
              const [user] = yield* db.query((raw) =>
                raw.select().from(users).where(eq(users.id, userId)),
              )
              if (!user)
                return yield* Effect.fail(makeError(AppErrorCodes.UserNotFound))
              const [updated] = yield* db.query((raw) =>
                raw
                  .update(users)
                  .set({
                    realName: parsed.realName ?? user.realName,
                    avatar: parsed.avatar ?? user.avatar,
                  })
                  .where(eq(users.id, userId))
                  .returning(),
              )
              return sanitizeUser(updated)
            }),
          ),
          Effect.tap((user) =>
            Effect.sync(() => logger.log('auth.updateInfo', { id: user.id })),
          ),
        ),

      changePassword: (userId, input) =>
        parseInput(ChangePasswordDto, input).pipe(
          Effect.flatMap((parsed) =>
            Effect.gen(function* () {
              const [user] = yield* db.query((raw) =>
                raw.select().from(users).where(eq(users.id, userId)),
              )
              if (!user)
                return yield* Effect.fail(makeError(AppErrorCodes.UserNotFound))
              const valid = yield* passwordService.verify(
                parsed.oldPassword,
                user.password,
              )
              if (!valid)
                return yield* Effect.fail(
                  makeError(AppErrorCodes.InvalidOldPassword),
                )
              const same = yield* passwordService.verify(
                parsed.newPassword,
                user.password,
              )
              if (same)
                return yield* Effect.fail(
                  makeError(AppErrorCodes.PasswordUnchanged),
                )
              const hashed = yield* passwordService.hash(parsed.newPassword)
              yield* db.query((raw) =>
                raw
                  .update(users)
                  .set({ password: hashed })
                  .where(eq(users.id, userId)),
              )
              return { success: true as const }
            }),
          ),
          Effect.tap(() =>
            Effect.sync(() => logger.log('auth.changePassword', { userId })),
          ),
        ),

      verifyToken: (token) =>
        Effect.try({
          try: () => {
            const payload = jwt.verify<{ sub: string }>(token)
            return payload.sub
          },
          catch: () => makeError(AppErrorCodes.TokenInvalid),
        }),
    }
  }),
)
