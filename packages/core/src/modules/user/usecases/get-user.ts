import { Effect } from 'effect'
import { UserNotFoundError } from '../errors.js'
import { UserRepository, toUser } from '../capabilities/user.repository.js'
import type { UserId } from '../domain.js'

export const getUser = ({ userId }: UserId) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository
    const user = yield* repository.findById(userId)
    if (!user) return yield* new UserNotFoundError({ userId })
    return toUser(user)
  })
