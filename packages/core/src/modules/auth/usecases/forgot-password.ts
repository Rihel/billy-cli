import { dayjs, nanoid } from '@repo/shared'
import { Config, Effect } from 'effect'
import { ApplicationLogger } from '../../../shared/application-logger.capability.js'
import { UserRepository } from '../../user/capabilities/user.repository.js'
import { AuthSuccessResult, type ForgotPasswordCommand } from '../domain.js'

export const forgotPassword = ({ email }: ForgotPasswordCommand) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository
    const applicationLogger = yield* ApplicationLogger
    const ttl = yield* Config.integer('RESET_PASSWORD_TOKEN_TTL_MINUTES').pipe(
      Config.withDefault(30),
    )
    const user = yield* repository.findByEmail(email)
    if (!user) {
      yield* Effect.sync(() =>
        applicationLogger.warn('auth.forgotPassword.userNotFound'),
      )
      return new AuthSuccessResult({ success: true })
    }
    const token = nanoid(32)
    yield* repository.update(user.id, {
      resetPasswordToken: token,
      resetPasswordTokenExpiry: dayjs().add(ttl, 'minute').toDate(),
    })
    return new AuthSuccessResult({ success: true, token })
  })
