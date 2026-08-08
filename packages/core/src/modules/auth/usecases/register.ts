import { Effect } from 'effect'
import { ApplicationLogger } from '../../../shared/application-logger.capability.js'
import { PasswordHasher } from '../../../shared/password-hasher.capability.js'
import { TokenSigner } from '../../../shared/token-signer.capability.js'
import {
  UserRepository,
  toUser,
} from '../../user/capabilities/user.repository.js'
import { EmailTakenError } from '../../user/errors.js'
import { AuthResult, type RegisterCommand } from '../domain.js'

export const register = (input: RegisterCommand) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository
    const passwordHasher = yield* PasswordHasher
    const tokenSigner = yield* TokenSigner
    const applicationLogger = yield* ApplicationLogger
    if (yield* repository.findByEmail(input.email)) {
      return yield* new EmailTakenError({ email: input.email })
    }
    const hashed = yield* passwordHasher.hash(input.password)
    const user = toUser(
      yield* repository.create({ ...input, password: hashed }),
    )
    const token = yield* tokenSigner.sign({ sub: user.id })
    yield* Effect.sync(() =>
      applicationLogger.log('auth.registered', { id: user.id }),
    )
    return new AuthResult({ token, user })
  })
