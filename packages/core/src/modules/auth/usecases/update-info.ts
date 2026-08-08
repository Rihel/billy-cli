import { Effect } from 'effect'
import { ApplicationLogger } from '../../../shared/application-logger.capability.js'
import {
  UserRepository,
  toUser,
} from '../../user/capabilities/user.repository.js'
import { UserNotFoundError } from '../../user/errors.js'
import type { UpdateInfoCommand } from '../domain.js'

export const updateInfo = ({ userId, ...changes }: UpdateInfoCommand) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository
    const applicationLogger = yield* ApplicationLogger
    const user = yield* repository.update(userId, changes)
    if (!user) return yield* new UserNotFoundError({ userId })
    yield* Effect.sync(() =>
      applicationLogger.log('auth.updateInfo', { id: userId }),
    )
    return toUser(user)
  })
