import { z } from 'zod'

/**
 * 文件分享（`/s/{token}`）的数据结构。
 *
 * 口径：
 * - **token 只出现在创建响应里**：库里只存它的 SHA-256，之后任何接口都不再返回；
 * - 时间统一用 **epoch 毫秒**（`expiresAt` / `revokedAt` / `createdAt` / `lastViewedAt`），
 *   前后端与 token 校验同一份口径，避免时区与字符串格式的歧义；
 * - `state` 是**派生值**（见 `shareState`），不落库。
 */

/** 一条分享的派生状态；对外一律折叠成 `invalid`（不给「存在但过期」的 oracle） */
export const ShareStateSchema = z.enum(['active', 'expired', 'revoked', 'invalid'])
export type ShareState = z.infer<typeof ShareStateSchema>

/** 预览类型：**服务端算好下发**，前端只 switch，不自己猜扩展名 */
export const PreviewKindSchema = z.enum([
  'image',
  'video',
  'audio',
  'pdf',
  'text',
  'markdown',
  'html',
  'office',
  'none',
])
export type PreviewKind = z.infer<typeof PreviewKindSchema>

/** Office 渲染器分支（docx / xlsx / pptx 各一套） */
export const OfficeKindSchema = z.enum(['docx', 'xlsx', 'pptx'])
export type OfficeKind = z.infer<typeof OfficeKindSchema>

/* ========== 创建 / 列表 / 撤销（登录态） ========== */

export const CreateShareSchema = z.object({
  fileId: z.string().min(1),
  /** 有效期（秒）：`null` = 永久，省略 = 用服务端默认值 */
  expiresIn: z
    .number()
    .int()
    .positive()
    .max(365 * 24 * 60 * 60)
    .nullable()
    .optional(),
})
export type CreateShareDto = z.infer<typeof CreateShareSchema>

export const CreateShareModelSchema = z.object({
  id: z.string(),
  /** 明文 token：**只此一次** */
  token: z.string(),
  /** 完整分享链接 */
  url: z.string(),
  expiresAt: z.number().int().nullable(),
})
export type CreateShareModel = z.infer<typeof CreateShareModelSchema>

export const ListShareSchema = z.object({
  fileId: z.string().min(1),
})
export type ListShareDto = z.infer<typeof ListShareSchema>

export const ShareItemModelSchema = z.object({
  id: z.string(),
  expiresAt: z.number().int().nullable(),
  revokedAt: z.number().int().nullable(),
  views: z.number().int().nonnegative(),
  lastViewedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  state: ShareStateSchema,
})
export type ShareItemModel = z.infer<typeof ShareItemModelSchema>

export const ListShareModelSchema = z.object({
  items: z.array(ShareItemModelSchema),
})
export type ListShareModel = z.infer<typeof ListShareModelSchema>

export const RevokeShareSchema = z.object({
  id: z.string().min(1),
})
export type RevokeShareDto = z.infer<typeof RevokeShareSchema>

/* ========== 访问（免授权） ========== */

export const ShareTokenSchema = z.object({
  token: z.string().min(1).max(128),
})
export type ShareTokenDto = z.infer<typeof ShareTokenSchema>

export const ShareMetaModelSchema = z.object({
  /** 展示名，不含路径 */
  filename: z.string(),
  mediaType: z.string(),
  previewKind: PreviewKindSchema,
  officeKind: OfficeKindSchema.nullable(),
  bytes: z.number().int().nonnegative(),
  expiresAt: z.number().int().nullable(),
})
export type ShareMetaModel = z.infer<typeof ShareMetaModelSchema>

export const ShareResolveModelSchema = z.object({
  /** 预签名下载地址：只在 server → Next 之间传递，**不进浏览器** */
  url: z.string(),
  filename: z.string(),
  mediaType: z.string(),
  bytes: z.number().int().nonnegative(),
})
export type ShareResolveModel = z.infer<typeof ShareResolveModelSchema>
