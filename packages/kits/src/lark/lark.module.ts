import type { InfraModuleAsyncOptions } from '../foundation/infra-module.js'
import { Global, Module, type DynamicModule } from '@nestjs/common'
import type { z } from 'zod'
import { LarkConfig, LarkConfigSchema } from './lark.config.js'
import { LarkClient } from './lark.client.js'

/** LarkModule.forRoot 入参 = LarkConfigSchema 的输入类型 */
export type LarkModuleOptions = z.input<typeof LarkConfigSchema>

/**
 * 飞书模块：`forRoot(options)` 显式传入应用凭据，配置对象本身即注入 bean（LarkConfig）。
 * 未导入本模块时 LarkClient 不存在，依赖方用 `@Optional()` 优雅降级。
 */
@Global()
@Module({})
export class LarkModule {
  static forRoot(options: LarkModuleOptions): DynamicModule {
    return {
      module: LarkModule,
      providers: [{ provide: LarkConfig, useValue: LarkConfigSchema.parse(options) }, LarkClient],
      exports: [LarkConfig, LarkClient],
    }
  }

  /**
   * 异步装配：配置由注入的 provider（如 ConfigService）惰性解析 ——
   * 避免在模块装饰器求值时读取尚未加载的配置。
   */
  static forRootAsync(options: InfraModuleAsyncOptions<LarkModuleOptions>): DynamicModule {
    return {
      module: LarkModule,
      imports: options.imports ?? [],
      providers: [
        { provide: LarkConfig, useFactory: options.useFactory, inject: options.inject ?? [] },
        LarkClient,
      ],
      exports: [LarkConfig, LarkClient],
    }
  }
}
