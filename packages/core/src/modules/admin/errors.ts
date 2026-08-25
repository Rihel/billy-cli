import { AppErrorCodes } from '@repo/shared'
import { AppError } from '../../foundation/errors/app-error.js'

export class AdminNotFoundError extends AppError {
  readonly code = AppErrorCodes.AdminNotFound
  constructor(readonly adminId?: string) {
    super(`Admin not found${adminId ? `: ${adminId}` : ''}`)
  }
}

export class AdminEmailTakenError extends AppError {
  readonly code = AppErrorCodes.AdminEmailTaken
  constructor(readonly email: string) {
    super(`Admin email already taken: ${email}`)
  }
}

export class AdminDisabledError extends AppError {
  readonly code = AppErrorCodes.AdminDisabled
  constructor(readonly email?: string) {
    super(`Admin disabled${email ? `: ${email}` : ''}`)
  }
}

export class InvalidAdminCredentialsError extends AppError {
  readonly code = AppErrorCodes.InvalidAdminCredentials
  constructor() {
    super('Invalid admin credentials')
  }
}

export class CannotRemoveSelfError extends AppError {
  readonly code = AppErrorCodes.CannotRemoveSelf
  constructor() {
    super('Cannot remove the currently logged-in admin')
  }
}
