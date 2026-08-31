import { z } from 'zod'

/**
 * 通知模块配置（Notifier 与各通知客户端共用）。
 *
 * 各通道独立配置段：**未配置的段对应的通知客户端不可用**
 * （`configured=false`，`send` 返回 `{ ok:false, error: '通道未配置' }`）。
 * 第一版实现 lark（飞书，基于 LarkClient）与 email；钉钉 / 企业微信段预留。
 */
export const NotifyConfigSchema = z.object({
  /** 飞书通知目标：基于 LarkClient（官方 SDK）发文本消息到该接收人（open_id / chat_id 等） */
  lark: z
    .object({
      /** 通知接收人 id（用户 open_id / 群 chat_id 等，取决于 receiveIdType） */
      receiveId: z.string(),
      /** 接收人 id 类型：open_id（默认）/ chat_id / union_id / user_id / email */
      receiveIdType: z
        .enum(['open_id', 'chat_id', 'union_id', 'user_id', 'email'])
        .default('open_id'),
    })
    .optional(),
  /** SMTP 邮件通道（from 为发件人；to 由调用方传入） */
  email: z
    .object({
      host: z.string(),
      port: z.number().int().default(465),
      secure: z.boolean().default(true),
      user: z.string().optional(),
      pass: z.string().optional(),
      from: z.string(),
    })
    .optional(),
})

export type NotifyConfig = z.infer<typeof NotifyConfigSchema>

/** DI 注入 token（NotifyConfig 是纯类型，用 Symbol 作运行时标识） */
export const NotifyConfig = Symbol.for('NotifyConfig')
