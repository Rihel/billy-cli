import { AppErrorCodes } from '@repo/shared'
import { AppError } from '../../shared/app-error.js'

export class EmailNotFoundError extends AppError {
  readonly code = AppErrorCodes.EmailNotFound
  constructor(readonly email: string) {
    super(`Email not found: ${email}`)
  }
}

export class InvalidCredentialsError extends AppError {
  readonly code = AppErrorCodes.InvalidCredentials
  constructor() {
    super('Invalid credentials')
  }
}

export class InvalidResetTokenError extends AppError {
  readonly code = AppErrorCodes.InvalidResetToken
  constructor() {
    super('Invalid reset token')
  }
}

export class ExpiredResetTokenError extends AppError {
  readonly code = AppErrorCodes.ExpiredResetToken
  constructor() {
    super('Expired reset token')
  }
}

export class InvalidOldPasswordError extends AppError {
  readonly code = AppErrorCodes.InvalidOldPassword
  constructor() {
    super('Invalid old password')
  }
}

export class PasswordUnchangedError extends AppError {
  readonly code = AppErrorCodes.PasswordUnchanged
  constructor() {
    super('Password unchanged')
  }
}

export class InvalidTokenError extends AppError {
  readonly code = AppErrorCodes.TokenInvalid
  constructor() {
    super('Invalid token')
  }
}
