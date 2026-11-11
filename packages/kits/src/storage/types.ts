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

/** 服务端写入对象（内部使用）：AI 产出 / 交付物没有前端预签名环节 */
export interface PutObjectInput {
  key: string
  body: Buffer
  contentType?: string
}

/** 写入结果（内部使用） */
export interface ObjectPut {
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

export interface ObjectListItem {
  key: string
  lastModified: Date
}

export interface ObjectStorageProvider {
  initial(): Promise<void>
  getObject(key: GetStorageDownloadUrlDto): Promise<ObjectContent>
  /** 服务端直接写对象（AI 产出的二进制走这里，不走预签名） */
  putObject(input: PutObjectInput): Promise<ObjectPut>
  getPresignedUrl(
    data: GetStorageUploadPresignedUrlDto,
  ): Promise<StoragePresignedUrlModel>
  getDownloadUrl(key: GetStorageDownloadUrlDto): Promise<StoragePresignedUrlModel>
  getTemporaryCredentials(
    request: GetTemporaryCredentialsDto,
  ): Promise<StorageStsModel>
  removeObject(key: GetStorageDownloadUrlDto): Promise<ObjectRemoved>
  /** 按前缀列出对象（预览临时对象的生命周期清理用） */
  listObjects(input: { prefix: string; max?: number }): Promise<ObjectListItem[]>
}
