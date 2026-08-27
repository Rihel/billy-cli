import { z } from 'zod'

/**
 * 认证基础组件配置（PasswordHasher 门面）：密码哈希强度。
 * 认证的业务策略（如找回密码 token 有效期）不属于 kits，由应用层自行定义配置。
 */
export const AuthConfigSchema = z.object({
  passwordHashRounds: z.coerce.number().default(10),
})

export type AuthConfig = z.infer<typeof AuthConfigSchema>

/** DI 注入 token（AuthConfig 是纯类型，用 Symbol 作运行时标识） */
export const AuthConfig = Symbol.for('AuthConfig')
