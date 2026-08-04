import { Context, Effect, Layer } from 'effect'
import * as bcrypt from 'bcryptjs'
import type { AppError } from '../errors.js'
import { ConfigService } from './config.service.js'
import { tryInfra } from './effect.js'

export interface IPasswordService {
  hash(password: string): Effect.Effect<string, AppError>
  verify(password: string, hash: string): Effect.Effect<boolean, AppError>
}

export class PasswordService extends Context.Tag('PasswordService')<
  PasswordService,
  IPasswordService
>() {}

export const PasswordServiceLive = Layer.effect(
  PasswordService,
  Effect.gen(function* () {
    const { passwordHashRounds } = (yield* ConfigService).auth

    return {
      hash: (password) =>
        tryInfra(
          () => bcrypt.hash(password, passwordHashRounds),
          '密码哈希失败',
        ),
      verify: (password, hash) =>
        tryInfra(() => bcrypt.compare(password, hash), '密码校验失败'),
    }
  }),
)
