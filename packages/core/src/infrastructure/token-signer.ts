import jsonwebtoken from 'jsonwebtoken'
import { inject, injectable } from 'inversify'
import { AppConfig } from '../foundation/app-config.js'
import { TokenSigningError } from '../foundation/errors/infrastructure-errors.js'


@injectable()
export class TokenSigner {
  constructor(@inject(AppConfig) private readonly config: AppConfig) {}

  async sign(payload: object): Promise<string> {
    try {
      return jsonwebtoken.sign(payload, this.config.jwt.secret, {
        expiresIn: this.config.jwt.expiresIn as never,
      })
    } catch (cause) {
      throw new TokenSigningError(cause)
    }
  }

  async verify<T extends object>(token: string): Promise<T> {
    try {
      return jsonwebtoken.verify(token, this.config.jwt.secret) as T
    } catch (cause) {
      throw new TokenSigningError(cause)
    }
  }
}
