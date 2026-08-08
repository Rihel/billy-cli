import { Effect } from 'effect'
import { ApplicationLogger } from '../../../shared/application-logger.capability.js'
import { UserNotFoundError } from '../errors.js'
import { UserRepository, toUser } from '../capabilities/user.repository.js'
import type { UpdateUser } from '../domain.js'

export const updateUser = ({ userId, ...changes }: UpdateUser) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository
    const applicationLogger = yield* ApplicationLogger
    const user = yield* repository.update(userId, changes)
    if (!user) return yield* new UserNotFoundError({ userId })
    yield* Effect.sync(() =>
      applicationLogger.log('user.updated', { id: userId }),
    )
    return toUser(user)
  })
