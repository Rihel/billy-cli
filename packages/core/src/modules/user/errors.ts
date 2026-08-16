import { AppErrorCodes } from '@repo/shared'
import { AppError } from '../../shared/app-error.js'

export class UserNotFoundError extends AppError {
  readonly code = AppErrorCodes.UserNotFound
  constructor(readonly userId?: string) {
    super(`User not found${userId ? `: ${userId}` : ''}`)
  }
}

export class EmailTakenError extends AppError {
  readonly code = AppErrorCodes.EmailTaken
  constructor(readonly email: string) {
    super(`Email already taken: ${email}`)
  }
}
