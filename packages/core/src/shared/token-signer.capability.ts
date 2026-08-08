import * as jsonwebtoken from 'jsonwebtoken'
import { Config, Context, Effect, Layer } from 'effect'
import { TokenSigningError } from './infrastructure-errors.js'
import { trySync } from './effect-adapters.js'

export interface TokenSignerApi {
  sign(payload: object): Effect.Effect<string, TokenSigningError>
  verify<T extends object>(token: string): Effect.Effect<T, TokenSigningError>
}

export class TokenSigner extends Context.Tag('TokenSigner')<
  TokenSigner,
  TokenSignerApi
>() {}

export const TokenSignerLive = Layer.effect(
  TokenSigner,
  Effect.gen(function* () {
    const secret = yield* Config.string('JWT_SECRET')
    const expiresIn = yield* Config.string('JWT_EXPIRES_IN').pipe(
      Config.withDefault('7d'),
    )
    return {
      sign: (payload) =>
        trySync(
          () =>
            jsonwebtoken.sign(payload, secret, {
              expiresIn: expiresIn as never,
            }),
          (cause) => new TokenSigningError({ cause }),
        ),
      verify: <T extends object>(token: string) =>
        trySync(
          () => jsonwebtoken.verify(token, secret) as T,
          (cause) => new TokenSigningError({ cause }),
        ),
    }
  }),
)
