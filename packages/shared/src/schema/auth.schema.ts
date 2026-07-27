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

/** 登录/注册结果模型 */
export const AuthResultModel = z.object({
  token: z.string(),
  user: UserModel,
})

/** 通用成功响应模型 */
export const SuccessResultModel = z.object({
  success: z.literal(true),
  token: z.string().optional(),
})
