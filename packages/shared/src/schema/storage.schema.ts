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
