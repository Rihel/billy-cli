import { z } from 'zod'

export const GetStorageUploadPresignedUrlSchema = z.object({
  key: z.string(),
  access: z.string().optional(),
})
export type GetStorageUploadPresignedUrlDto = z.infer<
  typeof GetStorageUploadPresignedUrlSchema
>

export const GetStorageDownloadUrlSchema = z.object({
  key: z.string(),
  /**
   * 下载时希望的原始文件名（可选）：服务端拼 `Content-Disposition: attachment` 用。
   *
   * 交付物的 key 是 md5 / 会话路径，不是给人看的文件名；下载时必须能还原原始名字。
   */
  filename: z.string().max(255).optional(),
})
export type GetStorageDownloadUrlDto = z.infer<
  typeof GetStorageDownloadUrlSchema
>

export const GetTemporaryCredentialsSchema = z.object({
  userId: z.string(),
})
export type GetTemporaryCredentialsDto = z.infer<
  typeof GetTemporaryCredentialsSchema
>

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
