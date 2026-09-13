import type { InfraModuleAsyncOptions } from '../foundation/infra-module.js'
import { Global, Module, type DynamicModule } from '@nestjs/common'
import type { z } from 'zod'
import {
  StorageConfig,
  StorageConfigSchema,
} from './storage.config.js'
import { ObjectStorage } from './object-storage.js'

/** ObjectStorageModule.forRoot 入参 = StorageConfigSchema 的输入类型 */
export type ObjectStorageModuleOptions = z.input<typeof StorageConfigSchema>

/**
 * 对象存储模块（S3 / COS）：`forRoot(options)` 显式传入存储配置，
 * 配置对象本身即注入 bean（StorageConfig）；运行时注入 RedisStore（S3 策略缓存）。
 */
@Global()
@Module({})
export class ObjectStorageModule {
  static forRoot(options: ObjectStorageModuleOptions): DynamicModule {
    return {
      module: ObjectStorageModule,
      providers: [
        { provide: StorageConfig, useValue: StorageConfigSchema.parse(options) },
        ObjectStorage,
      ],
      exports: [StorageConfig, ObjectStorage],
    }
  }

  /**
   * 异步装配：配置由注入的 provider（如 ConfigService）惰性解析 ——
   * 避免在模块装饰器求值时读取尚未加载的配置。
   */
  static forRootAsync(
    options: InfraModuleAsyncOptions<ObjectStorageModuleOptions>,
  ): DynamicModule {
    return {
      module: ObjectStorageModule,
      imports: options.imports ?? [],
      providers: [
        { provide: StorageConfig, useFactory: options.useFactory, inject: options.inject ?? [] },
        ObjectStorage,
      ],
      exports: [StorageConfig,
        ObjectStorage,],
    }
  }
}
