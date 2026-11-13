import type { InfraModuleAsyncOptions } from '../foundation/infra-module.js'
import { Global, Module, type DynamicModule } from '@nestjs/common'
import type { z } from 'zod'
import { RedisConfig, RedisConfigSchema } from './redis.config.js'
import { RedisLockService } from './redis-lock.service.js'
import { RedisStore } from './redis-store.js'

/** RedisModule.forRoot 入参 = RedisConfigSchema 的输入类型 */
export type RedisModuleOptions = z.input<typeof RedisConfigSchema>

/**
 * Redis 模块：`forRoot(options)` 显式传入连接配置，配置对象本身即注入 bean（RedisConfig）。
 *
 * 提供两个统一入口（依赖 Redis 的模块直接注入 RedisStore / RedisConfig）：
 * - RedisStore：键值与 JSON 读写、分布式锁基础版；
 * - RedisLockService：自旋等待 + 看门狗续期的分布式锁。
 * 限流器归 RateLimitModule（同目录结构的独立模块）。
 */
@Global()
@Module({})
export class RedisModule {
  static forRoot(options: RedisModuleOptions): DynamicModule {
    return {
      module: RedisModule,
      providers: [
        { provide: RedisConfig, useValue: RedisConfigSchema.parse(options) },
        RedisStore,
        RedisLockService,
      ],
      exports: [RedisConfig, RedisStore, RedisLockService],
    }
  }

  /**
   * 异步装配：配置由注入的 provider（如 ConfigService）惰性解析 ——
   * 避免在模块装饰器求值时读取尚未加载的配置。
   */
  static forRootAsync(options: InfraModuleAsyncOptions<RedisModuleOptions>): DynamicModule {
    return {
      module: RedisModule,
      imports: options.imports ?? [],
      providers: [
        { provide: RedisConfig, useFactory: options.useFactory, inject: options.inject ?? [] },
        RedisStore,
        RedisLockService,
      ],
      exports: [RedisConfig, RedisStore, RedisLockService],
    }
  }
}
