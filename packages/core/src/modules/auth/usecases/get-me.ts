import { Effect } from 'effect'
import {
  UserRepository,
  toUser,
} from '../../user/capabilities/user.repository.js'
import { UserNotFoundError } from '../../user/errors.js'
import type { AuthUserId } from '../domain.js'

export const getMe = ({ userId }: AuthUserId) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository
    const user = yield* repository.findById(userId)
    if (!user) return yield* new UserNotFoundError({ userId })
    return toUser(user)
  })
