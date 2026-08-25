import { nanoid } from '@repo/shared'
import { injectable } from 'inversify'


@injectable()
export class IdGeneration {
  next(length = 20): string {
    return nanoid(length)
  }
}
