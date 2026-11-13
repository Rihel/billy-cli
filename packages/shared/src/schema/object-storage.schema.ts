import { z } from 'zod'

export const GetStorageUploadPresignedUrlSchema = z.object({
  key: z.string(),
  access: z.string().optional(),
})
export type GetStorageUploadPresignedUrlDto = z.infer<typeof GetStorageUploadPresignedUrlSchema>

export const GetStorageDownloadUrlSchema = z.object({
  key: z.string(),
  /**
   * 下载时希望的原始文件名（可选）：服务端拼 `Content-Disposition: attachment` 用。
   *
   * 交付物的 key 是 md5 / 会话路径，不是给人看的文件名；下载时必须能还原原始名字。
   */
  filename: z.string().max(255).optional(),
  /**
   * 链接有效期（秒），缺省 3600。
   *
   * 分享链路里 server → Next 的预签名只用一次，会压到 300s；
   * 既有调用方不传，行为不变。
   */
  expiresIn: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 60 * 60)
    .optional(),
})
export type GetStorageDownloadUrlDto = z.infer<typeof GetStorageDownloadUrlSchema>

export const GetTemporaryCredentialsSchema = z.object({
  userId: z.string(),
})
export type GetTemporaryCredentialsDto = z.infer<typeof GetTemporaryCredentialsSchema>

export const StoragePresignedUrlSchema = z.object({
  key: z.string(),
  url: z.string(),
})
export type StoragePresignedUrlModel = z.infer<typeof StoragePresignedUrlSchema>

export const StorageStsSchema = z.object({
  endpoint: z.string(),
  bucket: z.string(),
  region: z.string(),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  sessionToken: z.string(),
  expiration: z.number(),
})
export type StorageStsModel = z.infer<typeof StorageStsSchema>
