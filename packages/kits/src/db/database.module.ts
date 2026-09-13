import type { InfraModuleAsyncOptions } from '../foundation/infra-module.js'
import { Global, Module, type DynamicModule } from '@nestjs/common'
import type { z } from 'zod'
import { DbConfig, DbConfigSchema } from './db.config.js'
import { Db } from './db.js'

/** DbModule.forRoot 入参 = DbConfigSchema 的输入类型 */
export type DbModuleOptions = z.input<typeof DbConfigSchema>

/**
 * 数据库模块：`forRoot(options)` 显式传入本模块配置，配置对象本身即注入 bean（DbConfig）。
 *
 * @example
 * imports: [DbModule.forRoot({ url: process.env.DB_URL, entities: [UserEntity], sync: true })]
 */
@Global()
@Module({})
export class DbModule {
  static forRoot(options: DbModuleOptions): DynamicModule {
    return {
      module: DbModule,
      providers: [
        { provide: DbConfig, useValue: DbConfigSchema.parse(options) },
        Db,
      ],
      exports: [DbConfig, Db],
    }
  }

  /**
   * 异步装配：配置由注入的 provider（如 ConfigService）惰性解析 ——
   * 避免在模块装饰器求值时读取尚未加载的配置。
   */
  static forRootAsync(
    options: InfraModuleAsyncOptions<DbModuleOptions>,
  ): DynamicModule {
    return {
      module: DbModule,
      imports: options.imports ?? [],
      providers: [
        { provide: DbConfig, useFactory: options.useFactory, inject: options.inject ?? [] },
        Db,
      ],
      exports: [DbConfig,
        Db,],
    }
  }
}
