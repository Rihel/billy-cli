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
import {
  ObjectStorageError,
  ObjectStorageUnavailableError,
} from '../foundation/errors/infrastructure-errors.js'
import { RedisStore } from '../redis/redis-store.js'
import { makeCosProvider } from './providers/cos.js'
import { makeS3Provider } from './providers/s3.js'
import type {
  ObjectContent,
  ObjectPut,
  ObjectRemoved,
  ObjectStorageProvider,
  PutObjectInput,
  ObjectListItem,
} from './types.js'

@Injectable()
export class ObjectStorage implements OnApplicationBootstrap {
  private readonly provider: ObjectStorageProvider
  /** 是否具备初始化条件：S3 必须配 endpoint；COS 走 bucket + region，视为已配置 */
  private readonly configured: boolean
  private initPromise: Promise<void> | null = null

  constructor(
    @Inject(StorageConfig) config: StorageConfig,
    @Inject(RedisStore) redis: RedisStore,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.configured =
      config.provider === 'cos' || Boolean(config.endpoint?.trim())
    this.provider =
      config.provider === 'cos'
        ? makeCosProvider(config, this.logger)
        : makeS3Provider(config, this.logger, redis)
  }

  /** 对外可查：存储能力是否具备初始化条件（未配置 ≠ 启动失败） */
  get enabled(): boolean {
    return this.configured
  }

  /**
   * 应用启动：尝试初始化 provider（S3 建桶/策略、COS 客户端创建）。
   *
   * **失败不拦启动**：对象存储是可选能力（README 口径），MinIO 没部署 / 暂时不可达
   * 都不该让整个服务起不来。这里只记警告，真正调用存储时再重试并报明确错误。
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.configured) {
      this.logger.warn('storage.disabled', {
        reason:
          '未配置 OBJECT_STORAGE_ENDPOINT，对象存储相关能力不可用（服务继续启动）',
      })
      return
    }
    try {
      await this.ensureInitialized()
    } catch (error) {
      this.logger.warn('storage.init_failed', {
        reason: error instanceof Error ? error.message : String(error),
        note: '对象存储不可达，服务继续启动；首次使用时重试',
      })
    }
  }

  /**
   * 确保 provider 已初始化（幂等）：S3 建桶/策略、COS 客户端创建等。
   *
   * 初始化失败**不缓存失败结果**：下次调用会重试（MinIO 可能刚被拉起来）。
   */
  private ensureInitialized(): Promise<void> {
    if (!this.configured) {
      return Promise.reject(new ObjectStorageUnavailableError())
    }
    if (!this.initPromise) {
      this.initPromise = this.provider.initial().catch((cause: unknown) => {
        this.initPromise = null
        throw cause
      })
    }
    return this.initPromise
  }

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (cause) {
      // 未配置是能力缺失，原样抛（保留中文说明），不要包成泛化的 "operation failed"
      if (cause instanceof ObjectStorageUnavailableError) throw cause
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

  /**
   * 服务端写入对象：AI 产出的文件没有"前端预签名直传"这一步。
   *
   * 大小上限由调用方（文件工具）在写入前判断；这里只负责把字节送进存储。
   */
  putObject(input: PutObjectInput): Promise<ObjectPut> {
    return this.guard('putObject', async () => {
      await this.ensureInitialized()
      return this.provider.putObject(input)
    })
  }

  removeObject(key: GetStorageDownloadUrlDto): Promise<ObjectRemoved> {
    return this.guard('removeObject', async () => {
      await this.ensureInitialized()
      return this.provider.removeObject(key)
    })
  }

  listObjects(input: { prefix: string; max?: number }): Promise<ObjectListItem[]> {
    return this.guard('listObjects', async () => {
      await this.ensureInitialized()
      return this.provider.listObjects(input)
    })
  }
}
