import type { InfraModuleAsyncOptions } from '../foundation/infra-module.js'
import { Global, Module, type DynamicModule } from '@nestjs/common'
import type { z } from 'zod'
import { JwtConfig, JwtConfigSchema } from './jwt.config.js'
import { TokenSigner } from './token-signer.js'

/** JwtModule.forRoot 入参 = JwtConfigSchema 的输入类型 */
export type JwtModuleOptions = z.input<typeof JwtConfigSchema>

/** JWT 模块：签发令牌（TokenSigner），配置对象本身即注入 bean（JwtConfig） */
@Global()
@Module({})
export class JwtModule {
  static forRoot(options: JwtModuleOptions): DynamicModule {
    return {
      module: JwtModule,
      providers: [{ provide: JwtConfig, useValue: JwtConfigSchema.parse(options) }, TokenSigner],
      exports: [JwtConfig, TokenSigner],
    }
  }

  /**
   * 异步装配：配置由注入的 provider（如 ConfigService）惰性解析 ——
   * 避免在模块装饰器求值时读取尚未加载的配置。
   */
  static forRootAsync(options: InfraModuleAsyncOptions<JwtModuleOptions>): DynamicModule {
    return {
      module: JwtModule,
      imports: options.imports ?? [],
      providers: [
        { provide: JwtConfig, useFactory: options.useFactory, inject: options.inject ?? [] },
        TokenSigner,
      ],
      exports: [JwtConfig, TokenSigner],
    }
  }
}
