import { z } from 'zod'

/** Redis 组件配置（RedisStore / RedisLockService / RateLimiter 共用）：连接串 + key 前缀。 */
export const RedisConfigSchema = z.object({
  url: z.string().default('redis://localhost:6379/0'),
  keyPrefix: z.string().optional(),
})

export type RedisConfig = z.infer<typeof RedisConfigSchema>

/** DI 注入 token（RedisConfig 是纯类型，用 Symbol 作运行时标识） */
export const RedisConfig = Symbol.for('RedisConfig')
