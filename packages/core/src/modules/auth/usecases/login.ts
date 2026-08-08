import { Effect } from 'effect'
import { ApplicationLogger } from '../../../shared/application-logger.capability.js'
import { PasswordHasher } from '../../../shared/password-hasher.capability.js'
import { TokenSigner } from '../../../shared/token-signer.capability.js'
import {
  UserRepository,
  toUser,
} from '../../user/capabilities/user.repository.js'
import { EmailNotFoundError, InvalidCredentialsError } from '../errors.js'
import { AuthResult, type LoginCommand } from '../domain.js'

export const login = (input: LoginCommand) =>
  Effect.gen(function* () {
    const repository = yield* UserRepository
    const passwordHasher = yield* PasswordHasher
    const tokenSigner = yield* TokenSigner
    const applicationLogger = yield* ApplicationLogger
    const record = yield* repository.findByEmail(input.email)
    if (!record) return yield* new EmailNotFoundError({ email: input.email })
    if (!(yield* passwordHasher.verify(input.password, record.password))) {
      return yield* new InvalidCredentialsError()
    }
    const user = toUser(record)
    const token = yield* tokenSigner.sign({ sub: user.id })
    yield* Effect.sync(() =>
      applicationLogger.log('auth.login', { id: user.id }),
    )
    return new AuthResult({ token, user })
  })
