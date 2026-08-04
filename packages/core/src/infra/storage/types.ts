import type {
  GetStorageUploadPresignedUrlDto,
  StoragePresignedUrlModel,
  StorageStsModel,
} from '@repo/shared'
import type { z } from 'zod'

export interface StorageProviderConfig {
  provider: 's3' | 'cos'
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string
}

export interface IStorageProvider {
  readonly providerName: string
  initial(): Promise<void>
  getObject(key: string): Promise<Buffer>
  getPresignedUrl(
    data: z.infer<typeof GetStorageUploadPresignedUrlDto>,
  ): Promise<z.infer<typeof StoragePresignedUrlModel>>
  getDownloadUrl(key: string): Promise<z.infer<typeof StoragePresignedUrlModel>>
  getTemporaryCredentials(
    userId: string,
  ): Promise<z.infer<typeof StorageStsModel>>
  removeObject(key: string): Promise<void>
}
