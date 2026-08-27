import jsonwebtoken from 'jsonwebtoken'
import { Inject, Injectable } from '@repo/di'
import { JwtConfig } from '../foundation/config/jwt-config.js'
import { TokenSigningError } from '../foundation/errors/infrastructure-errors.js'


@Injectable()
export class TokenSigner {
  constructor(@Inject(JwtConfig) private readonly config: JwtConfig) {}

  async sign(payload: object): Promise<string> {
    try {
      return jsonwebtoken.sign(payload, this.config.secret, {
        expiresIn: this.config.expiresIn as never,
      })
    } catch (cause) {
      throw new TokenSigningError(cause)
    }
  }

  async verify<T extends object>(token: string): Promise<T> {
    try {
      return jsonwebtoken.verify(token, this.config.secret) as T
    } catch (cause) {
      throw new TokenSigningError(cause)
    }
  }
}
