import { Effect } from 'effect'
import { ApplicationLogger } from '../../../shared/application-logger.capability.js'
import { UserNotFoundError } from '../errors.js'
import { UserRepository } from '../capabilities/user.repository.js'
import { UserSuccessResult, type RemoveUser } from '../domain.js'

export const removeUser = ({ userId }: RemoveUser) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository
    const applicationLogger = yield* ApplicationLogger
    const user = yield* repository.remove(userId)
    if (!user) return yield* new UserNotFoundError({ userId })
    yield* Effect.sync(() =>
      applicationLogger.log('user.removed', { id: userId }),
    )
    return new UserSuccessResult({ success: true })
  })
