import { Data } from 'effect'
import type { User } from '../user/domain.js'

export class AuthResult extends Data.Class<{
  token: string
  user: User
}> {}

export class AuthSuccessResult extends Data.Class<{
  success: true
  token?: string
}> {}

export class RegisterCommand extends Data.Class<{
  email: string
  password: string
  realName?: string
}> {}

export class LoginCommand extends Data.Class<{
  email: string
  password: string
}> {}

export class ForgotPasswordCommand extends Data.Class<{
  email: string
}> {}

export class ResetPasswordCommand extends Data.Class<{
  token: string
  password: string
}> {}

export class UpdateInfoCommand extends Data.Class<{
  userId: string
  realName?: string | null
  avatar?: string | null
}> {}

export class ChangePasswordCommand extends Data.Class<{
  userId: string
  oldPassword: string
  newPassword: string
}> {}

export class AuthUserId extends Data.Class<{ userId: string }> {}

export class AccessToken extends Data.Class<{ token: string }> {}
