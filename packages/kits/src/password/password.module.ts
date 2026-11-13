import type { InfraModuleAsyncOptions } from '../foundation/infra-module.js'
import { Global, Module, type DynamicModule } from '@nestjs/common'
import type { z } from 'zod'
import { PasswordConfig, PasswordConfigSchema } from './password.config.js'
import { PasswordHasher } from './password-hasher.js'

/** PasswordModule.forRoot 入参 = PasswordConfigSchema 的输入类型 */
export type PasswordModuleOptions = z.input<typeof PasswordConfigSchema>

/**
 * 密码模块：`forRoot(options)` 显式传入哈希强度，配置对象本身即注入 bean（PasswordConfig）。
 */
@Global()
@Module({})
export class PasswordModule {
  static forRoot(options: PasswordModuleOptions): DynamicModule {
    return {
      module: PasswordModule,
      providers: [
        { provide: PasswordConfig, useValue: PasswordConfigSchema.parse(options) },
        PasswordHasher,
      ],
      exports: [PasswordConfig, PasswordHasher],
    }
  }

  /**
   * 异步装配：配置由注入的 provider（如 ConfigService）惰性解析 ——
   * 避免在模块装饰器求值时读取尚未加载的配置。
   */
  static forRootAsync(options: InfraModuleAsyncOptions<PasswordModuleOptions>): DynamicModule {
    return {
      module: PasswordModule,
      imports: options.imports ?? [],
      providers: [
        { provide: PasswordConfig, useFactory: options.useFactory, inject: options.inject ?? [] },
        PasswordHasher,
      ],
      exports: [PasswordConfig, PasswordHasher],
    }
  }
}
