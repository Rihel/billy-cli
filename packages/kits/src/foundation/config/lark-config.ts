import { z } from 'zod'

/** 飞书（Lark）开放平台应用配置：LarkClient（官方 SDK 封装）使用。 */
export const LarkConfigSchema = z.object({
  /** 应用 App ID */
  appId: z.string(),
  /** 应用 App Secret */
  appSecret: z.string(),
  /** 开放平台域名：feishu（国内，默认）/ lark（国际） */
  domain: z.enum(['feishu', 'lark']).default('feishu'),
})

export type LarkConfig = z.infer<typeof LarkConfigSchema>

/** DI 注入 token（LarkConfig 是纯类型，用 Symbol 作运行时标识） */
export const LarkConfig = Symbol.for('LarkConfig')
