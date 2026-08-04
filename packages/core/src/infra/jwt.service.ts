import { Context, Effect, Layer } from 'effect'
import * as jwt from 'jsonwebtoken'
import { ConfigService } from './config.service.js'

export interface IJwt {
  sign(payload: object): string
  verify<T extends object>(token: string): T
}

export class JwtService extends Context.Tag('JwtService')<JwtService, IJwt>() {}

export const JwtServiceLive = Layer.effect(
  JwtService,
  Effect.gen(function* () {
    const { jwt: config } = yield* ConfigService
    return {
      sign: (payload: object) =>
        jwt.sign(payload, config.secret, { expiresIn: (config.expiresIn ?? '7d') as any }),
      verify: <T extends object>(token: string) =>
        jwt.verify(token, config.secret) as T,
    }
  }),
)
