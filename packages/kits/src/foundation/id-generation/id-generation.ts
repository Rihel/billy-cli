import { nanoid } from '@repo/shared'
import { Injectable } from '@nestjs/common'

@Injectable()
export class IdGeneration {
  next(length = 20): string {
    return nanoid(length)
  }
}
