import { Effect } from 'effect'
import { UserRepository } from '../capabilities/user.repository.js'
import type { UserPageQuery } from '../domain.js'

export const pageUsers = (query: UserPageQuery) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository
    return yield* repository.page(query)
  })
