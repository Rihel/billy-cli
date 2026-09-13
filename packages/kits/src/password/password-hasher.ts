import bcrypt from 'bcryptjs'
import { Inject, Injectable } from '@nestjs/common'
import { PasswordConfig } from './password.config.js'
import { PasswordHashingError } from '../foundation/errors/infrastructure-errors.js'


@Injectable()
export class PasswordHasher {
  constructor(@Inject(PasswordConfig) private readonly config: PasswordConfig) {}

  async hash(password: string): Promise<string> {
    try {
      return await bcrypt.hash(password, this.config.passwordHashRounds)
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
