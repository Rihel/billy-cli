import jsonwebtoken from 'jsonwebtoken'
import { inject, injectable } from 'inversify'
import { AppConfig } from './app-config.js'
import { TokenSigningError } from './infrastructure-errors.js'


@injectable()
export class TokenSigner {
  constructor(@inject(AppConfig) private readonly config: AppConfig) {}

  async sign(payload: object): Promise<string> {
    try {
      return jsonwebtoken.sign(payload, this.config.jwtSecret, {
        expiresIn: this.config.jwtExpiresIn as never,
      })
    } catch (cause) {
      throw new TokenSigningError(cause)
    }
  }

  async verify<T extends object>(token: string): Promise<T> {
    try {
      return jsonwebtoken.verify(token, this.config.jwtSecret) as T
    } catch (cause) {
      throw new TokenSigningError(cause)
    }
  }
}
