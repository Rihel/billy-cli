import bcrypt from 'bcryptjs'
import { inject, injectable } from 'inversify'
import { AppConfig } from '../foundation/app-config.js'
import { PasswordHashingError } from '../foundation/errors/infrastructure-errors.js'


@injectable()
export class PasswordHasher {
  constructor(@inject(AppConfig) private readonly config: AppConfig) {}

  async hash(password: string): Promise<string> {
    try {
      return await bcrypt.hash(password, this.config.auth.passwordHashRounds)
    } catch (cause) {
      throw new PasswordHashingError(cause)
    }
  }

  async verify(password: string, hash: string): Promise<boolean> {
    try {
      return await bcrypt.compare(password, hash)
    } catch (cause) {
      throw new PasswordHashingError(cause)
    }
  }
}
