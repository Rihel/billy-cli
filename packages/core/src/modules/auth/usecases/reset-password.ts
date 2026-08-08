import { dayjs } from '@repo/shared'
import { Effect } from 'effect'
import { PasswordHasher } from '../../../shared/password-hasher.capability.js'
import { UserRepository } from '../../user/capabilities/user.repository.js'
import { ExpiredResetTokenError, InvalidResetTokenError } from '../errors.js'
import { AuthSuccessResult, type ResetPasswordCommand } from '../domain.js'

export const resetPassword = (input: ResetPasswordCommand) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository
    const passwordHasher = yield* PasswordHasher
    const user = yield* repository.findByResetToken(input.token)
    if (!user) return yield* new InvalidResetTokenError()
    if (
      !user.resetPasswordTokenExpiry ||
      dayjs().isAfter(user.resetPasswordTokenExpiry)
    ) {
      return yield* new ExpiredResetTokenError()
    }
    const hashed = yield* passwordHasher.hash(input.password)
    yield* repository.update(user.id, {
      password: hashed,
      resetPasswordToken: null,
      resetPasswordTokenExpiry: null,
    })
    return new AuthSuccessResult({ success: true })
  })
