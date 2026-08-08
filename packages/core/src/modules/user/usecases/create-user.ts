import { Effect } from 'effect'
import { ApplicationLogger } from '../../../shared/application-logger.capability.js'
import { PasswordHasher } from '../../../shared/password-hasher.capability.js'
import { EmailTakenError } from '../errors.js'
import { UserRepository, toUser } from '../capabilities/user.repository.js'
import type { CreateUser } from '../domain.js'

export const createUser = (input: CreateUser) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository
    const passwordHasher = yield* PasswordHasher
    const applicationLogger = yield* ApplicationLogger
    const existing = yield* repository.findByEmail(input.email)
    if (existing) return yield* new EmailTakenError({ email: input.email })
    const hashed = yield* passwordHasher.hash(input.password)
    const user = toUser(
      yield* repository.create({ ...input, password: hashed }),
    )
    yield* Effect.sync(() =>
      applicationLogger.log('user.created', { id: user.id }),
    )
    return user
  })
