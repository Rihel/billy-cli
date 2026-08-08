import { Effect } from 'effect'
import { ApplicationLogger } from '../../../shared/application-logger.capability.js'
import { PasswordHasher } from '../../../shared/password-hasher.capability.js'
import { UserRepository } from '../../user/capabilities/user.repository.js'
import { UserNotFoundError } from '../../user/errors.js'
import { InvalidOldPasswordError, PasswordUnchangedError } from '../errors.js'
import { AuthSuccessResult, type ChangePasswordCommand } from '../domain.js'

export const changePassword = ({
  userId,
  oldPassword,
  newPassword,
}: ChangePasswordCommand) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository
    const passwordHasher = yield* PasswordHasher
    const applicationLogger = yield* ApplicationLogger
    const user = yield* repository.findById(userId)
    if (!user) return yield* new UserNotFoundError({ userId })
    if (!(yield* passwordHasher.verify(oldPassword, user.password))) {
      return yield* new InvalidOldPasswordError()
    }
    if (yield* passwordHasher.verify(newPassword, user.password)) {
      return yield* new PasswordUnchangedError()
    }
    const hashed = yield* passwordHasher.hash(newPassword)
    yield* repository.update(userId, { password: hashed })
    yield* Effect.sync(() =>
      applicationLogger.log('auth.changePassword', { id: userId }),
    )
    return new AuthSuccessResult({ success: true })
  })
