import { Effect } from 'effect'
import { TokenSigner } from '../../../shared/token-signer.capability.js'
import { InvalidTokenError } from '../errors.js'
import type { AccessToken } from '../domain.js'

export const verifyToken = ({ token }: AccessToken) =>
  Effect.gen(function* () {
    const tokenSigner = yield* TokenSigner
    const payload = yield* tokenSigner
      .verify<{ sub: string }>(token)
      .pipe(Effect.mapError(() => new InvalidTokenError()))
    return payload.sub
  })
