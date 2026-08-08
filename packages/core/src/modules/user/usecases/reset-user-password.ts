import { Effect } from 'effect'
import { ApplicationLogger } from '../../../shared/application-logger.capability.js'
import { PasswordHasher } from '../../../shared/password-hasher.capability.js'
import { UserNotFoundError } from '../errors.js'
import { UserRepository } from '../capabilities/user.repository.js'
import { UserSuccessResult, type ResetUserPassword } from '../domain.js'

export const resetUserPassword = ({
  userId,
  password: rawPassword,
}: ResetUserPassword) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository
    const passwordHasher = yield* PasswordHasher
    const applicationLogger = yield* ApplicationLogger
    const hashed = yield* passwordHasher.hash(rawPassword)
    const user = yield* repository.update(userId, { password: hashed })
    if (!user) return yield* new UserNotFoundError({ userId })
    yield* Effect.sync(() =>
      applicationLogger.log('user.passwordReset', { id: userId }),
    )
    return new UserSuccessResult({ success: true })
  })
