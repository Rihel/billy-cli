import { z } from 'zod'

/** JWT 组件配置（TokenSigner / SessionStore 共用）：密钥 + 有效期。 */
export const JwtConfigSchema = z.object({
  secret: z.string().default('default-secret-change-in-production'),
  expiresIn: z.string().default('7d'),
})

export type JwtConfig = z.infer<typeof JwtConfigSchema>

/** DI 注入 token（JwtConfig 是纯类型，用 Symbol 作运行时标识） */
export const JwtConfig = Symbol.for('JwtConfig')
