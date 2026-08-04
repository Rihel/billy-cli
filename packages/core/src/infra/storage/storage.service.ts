import { Context, Effect, Layer, Option } from 'effect'
import type {
  GetStorageUploadPresignedUrlDto,
  StoragePresignedUrlModel,
  StorageStsModel,
} from '@repo/shared'
import type { z } from 'zod'
import type { AppError } from '../../errors.js'

import { ConfigService } from '../config.service.js'
import { LoggerService } from '../logger.service.js'
import { RedisService } from '../redis.service.js'
import type { IStorageProvider } from './types.js'
import { makeS3Provider } from './s3.js'
import { makeCosProvider } from './cos.js'
import { fromPromise } from '../../effects/index.js'

export interface IStorageService {
  getPresignedUrl(
    data: z.infer<typeof GetStorageUploadPresignedUrlDto>,
  ): Effect.Effect<z.infer<typeof StoragePresignedUrlModel>, AppError>
  getDownloadUrl(
    key: string,
  ): Effect.Effect<z.infer<typeof StoragePresignedUrlModel>, AppError>
  getTemporaryCredentials(
    userId: string,
  ): Effect.Effect<z.infer<typeof StorageStsModel>, AppError>
  getObject(key: string): Effect.Effect<Buffer, AppError>
  removeObject(key: string): Effect.Effect<void, AppError>
}

export class StorageService extends Context.Tag('StorageService')<
  StorageService,
  IStorageService
>() {}

export const StorageServiceLive = Layer.scoped(
  StorageService,
  Effect.gen(function* () {
    const { storage: config } = yield* ConfigService
    const logger = yield* LoggerService
    // RedisService is optional — used for STS token caching in S3 provider
    const redis = yield* Effect.serviceOption(RedisService)
    const redisInstance = Option.getOrUndefined(redis)

    const selectedProvider: IStorageProvider =
      config.provider === 's3'
        ? makeS3Provider(config, logger, redisInstance)
        : makeCosProvider(config, logger)

    const provider = yield* Effect.acquireRelease(
      fromPromise(async () => {
        await selectedProvider.initial()
        return selectedProvider
      }, `初始化 ${config.provider} 存储服务失败`),
      () => Effect.void,
    )

    const callProvider = <A>(
      operation: (provider: IStorageProvider) => Promise<A>,
      message: string,
    ) => fromPromise(() => operation(provider), message)

    return {
      getPresignedUrl: (data) =>
        callProvider(
          (current) => current.getPresignedUrl(data),
          '生成上传链接失败',
        ),

      getDownloadUrl: (key) =>
        callProvider(
          (current) => current.getDownloadUrl(key),
          '生成下载链接失败',
        ),

      getTemporaryCredentials: (userId) =>
        callProvider(
          (current) => current.getTemporaryCredentials(userId),
          '获取临时凭证失败',
        ),

      getObject: (key) =>
        callProvider((current) => current.getObject(key), '读取存储对象失败'),

      removeObject: (key) =>
        callProvider(
          (current) => current.removeObject(key),
          '删除存储对象失败',
        ),
    }
  }),
)
