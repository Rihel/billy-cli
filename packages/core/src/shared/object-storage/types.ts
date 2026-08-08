import type {
  ObjectContent,
  ObjectKey,
  ObjectRemoved,
  PresignedObjectUrl,
  TemporaryCredentials,
  TemporaryCredentialsRequest,
  UploadObject,
} from './domain.js'

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
  getObject(key: ObjectKey): Promise<ObjectContent>
  getPresignedUrl(data: UploadObject): Promise<PresignedObjectUrl>
  getDownloadUrl(key: ObjectKey): Promise<PresignedObjectUrl>
  getTemporaryCredentials(
    request: TemporaryCredentialsRequest,
  ): Promise<TemporaryCredentials>
  removeObject(key: ObjectKey): Promise<ObjectRemoved>
}
