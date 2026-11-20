import { AppErrorCodes } from '@repo/shared'
import { AppError } from '@repo/kits'

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

export class AdminTypeForbiddenError extends AppError {
  readonly code = AppErrorCodes.AdminTypeForbidden
  constructor() {
    super('Only a super admin can change the admin type')
  }
}

export class LastGodAdminRequiredError extends AppError {
  readonly code = AppErrorCodes.LastGodAdminRequired
  constructor() {
    super('At least one super admin must remain')
  }
}
