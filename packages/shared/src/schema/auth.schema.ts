import { z } from 'zod'
import { BaseModel } from './base.schema'

export const UserModel = z.intersection(
  BaseModel,
  z.object({
    email: z.email(),
    realName: z.string().nullable().optional(),
    avatar: z.string().nullable().optional(),
  }),
)

export const UpdateInfoDto = z.object({
  realName: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
})

export const RegisterDto = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  realName: z.string().optional(),
})

export const LoginDto = z.object({
  email: z.string().email(),
  password: z.string(),
})

export const ForgotPasswordDto = z.object({
  email: z.string().email(),
})

export const ResetPasswordDto = z.object({
  token: z.string(),
  password: z.string().min(6),
})

export const ChangePasswordDto = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(6),
})

export const AuthResultDto = z.object({
  token: z.string(),
  user: UserModel,
})
