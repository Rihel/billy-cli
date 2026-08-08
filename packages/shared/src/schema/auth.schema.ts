import { z } from 'zod'
import { BaseModel } from './base.schema'

export const AuthUserSchema = BaseModel.extend({
  email: z.email(),
  realName: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
})
export type AuthUserModel = z.infer<typeof AuthUserSchema>

export const UpdateInfoSchema = z.object({
  realName: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
})
export type UpdateInfoDto = z.infer<typeof UpdateInfoSchema>

export const RegisterSchema = z.object({
  email: z.email(),
  password: z.string().min(6),
  realName: z.string().optional(),
})
export type RegisterDto = z.infer<typeof RegisterSchema>
export const LoginSchema = z.object({
  email: z.email(),
  password: z.string(),
})
export type LoginDto = z.infer<typeof LoginSchema>

export const ForgotPasswordSchema = z.object({
  email: z.email(),
})
export type ForgotPasswordDto = z.infer<typeof ForgotPasswordSchema>

export const ResetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(6),
})
export type ResetPasswordDto = z.infer<typeof ResetPasswordSchema>

export const ChangePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(6),
})
export type ChangePasswordDto = z.infer<typeof ChangePasswordSchema>

/** 登录/注册结果模型 */
export const AuthResultSchema = z.object({
  token: z.string(),
  user: AuthUserSchema,
})
export type AuthResultModel = z.infer<typeof AuthResultSchema>

/** 通用成功响应模型 */
export const SuccessResultSchema = z.object({
  success: z.literal(true),
  token: z.string().optional(),
})
export type SuccessResultModel = z.infer<typeof SuccessResultSchema>
