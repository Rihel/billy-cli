import { z } from 'zod'

export const GetStorageUploadPresignedUrlDto = z.object({
  key: z.string(),
  access: z.string().optional(),
})

export const GetStorageDownloadUrlDto = z.object({
  key: z.string(),
})

export const GetTemporaryCredentialsDto = z.object({
  userId: z.string(),
})

export const StoragePresignedUrlModel = z.object({
  key: z.string(),
  url: z.string(),
})

export const StorageStsModel = z.object({
  endpoint: z.string(),
  bucket: z.string(),
  region: z.string(),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  sessionToken: z.string(),
  expiration: z.number(),
})
