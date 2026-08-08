import * as bcrypt from 'bcryptjs'
import { Config, Context, Effect, Layer } from 'effect'
import { makePromiseAdapter } from './effect-adapters.js'
import { PasswordHashingError } from './infrastructure-errors.js'

export interface PasswordHasherApi {
  hash(password: string): Effect.Effect<string, PasswordHashingError>
  verify(
    password: string,
    hash: string,
  ): Effect.Effect<boolean, PasswordHashingError>
}

export class PasswordHasher extends Context.Tag('PasswordHasher')<
  PasswordHasher,
  PasswordHasherApi
>() {}

export const PasswordHasherLive = Layer.effect(
  PasswordHasher,
  Effect.gen(function* () {
    const rounds = yield* Config.integer('PASSWORD_HASH_ROUNDS').pipe(
      Config.withDefault(10),
    )
    const fromPromise = makePromiseAdapter(
      (cause) => new PasswordHashingError({ cause }),
    )

    return {
      hash: (password) => fromPromise(() => bcrypt.hash(password, rounds)),
      verify: (password, hash) =>
        fromPromise(() => bcrypt.compare(password, hash)),
    }
  }),
)
