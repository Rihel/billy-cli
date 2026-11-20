import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

export class MarketItemNotFoundError extends AppError {
  readonly code = AppErrorCodes.MarketItemNotFound
  constructor(readonly key: string) {
    super(`Market item not found: ${key}`)
  }
}
