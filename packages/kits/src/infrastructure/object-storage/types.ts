import type {
  GetStorageDownloadUrlDto,
  GetTemporaryCredentialsDto,
  GetStorageUploadPresignedUrlDto,
  StoragePresignedUrlModel,
  StorageStsModel,
} from '@repo/shared'

/** 读取对象内容（内部使用，不暴露到 API 层） */
export interface ObjectContent {
  key: string
  body: Buffer
}

/** 删除对象结果（内部使用） */
export interface ObjectRemoved {
  key: string
}

export interface ObjectStorageConfig {
  provider: 's3' | 'cos'
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string
}

export interface ObjectStorageProvider {
  initial(): Promise<void>
  getObject(key: GetStorageDownloadUrlDto): Promise<ObjectContent>
  getPresignedUrl(
    data: GetStorageUploadPresignedUrlDto,
  ): Promise<StoragePresignedUrlModel>
  getDownloadUrl(key: GetStorageDownloadUrlDto): Promise<StoragePresignedUrlModel>
  getTemporaryCredentials(
    request: GetTemporaryCredentialsDto,
  ): Promise<StorageStsModel>
  removeObject(key: GetStorageDownloadUrlDto): Promise<ObjectRemoved>
}
