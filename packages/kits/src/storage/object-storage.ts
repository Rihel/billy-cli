import type {
  GetStorageDownloadUrlDto,
  GetStorageUploadPresignedUrlDto,
  GetTemporaryCredentialsDto,
  StoragePresignedUrlModel,
  StorageStsModel,
} from '@repo/shared'
import { AppLogger } from '../foundation/logger/app-logger.js'
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { StorageConfig } from './storage.config.js'
import { ObjectStorageError } from '../foundation/errors/infrastructure-errors.js'
import { RedisStore } from '../redis/redis-store.js'
import { makeCosProvider } from './providers/cos.js'
import { makeS3Provider } from './providers/s3.js'
import type { ObjectContent, ObjectRemoved, ObjectStorageProvider } from './types.js'

@Injectable()
export class ObjectStorage implements OnApplicationBootstrap {
  private readonly provider: ObjectStorageProvider
  private initPromise: Promise<void> | null = null


  constructor(
    @Inject(StorageConfig) config: StorageConfig,
    @Inject(RedisStore) redis: RedisStore,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.provider =
      config.provider === 'cos'
        ? makeCosProvider(config, this.logger)
        : makeS3Provider(config, this.logger, redis)
  }

  /** 应用启动：初始化 provider（S3 建桶/策略、COS 客户端创建）。 */
  async onApplicationBootstrap(): Promise<void> {
    await this.ensureInitialized()
  }

  /** 确保 provider 已初始化（幂等）：S3 建桶/策略、COS 客户端创建等。 */
  private ensureInitialized(): Promise<void> {
    return (this.initPromise ??= this.provider.initial())
  }

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (cause) {
      throw new ObjectStorageError(operation, cause)
    }
  }

  getPresignedUrl(
    data: GetStorageUploadPresignedUrlDto,
  ): Promise<StoragePresignedUrlModel> {
    return this.guard('getPresignedUrl', async () => {
      await this.ensureInitialized()
      return this.provider.getPresignedUrl(data)
    })
  }

  getDownloadUrl(key: GetStorageDownloadUrlDto): Promise<StoragePresignedUrlModel> {
    return this.guard('getDownloadUrl', async () => {
      await this.ensureInitialized()
      return this.provider.getDownloadUrl(key)
    })
  }

  getTemporaryCredentials(
    request: GetTemporaryCredentialsDto,
  ): Promise<StorageStsModel> {
    return this.guard('getTemporaryCredentials', async () => {
      await this.ensureInitialized()
      return this.provider.getTemporaryCredentials(request)
    })
  }

  getObject(key: GetStorageDownloadUrlDto): Promise<ObjectContent> {
    return this.guard('getObject', async () => {
      await this.ensureInitialized()
      return this.provider.getObject(key)
    })
  }

  removeObject(key: GetStorageDownloadUrlDto): Promise<ObjectRemoved> {
    return this.guard('removeObject', async () => {
      await this.ensureInitialized()
      return this.provider.removeObject(key)
    })
  }
}
