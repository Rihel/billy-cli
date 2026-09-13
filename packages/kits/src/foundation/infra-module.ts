import type { InjectionToken, ModuleMetadata } from '@nestjs/common'

/**
 * 基础设施模块 `forRootAsync` 的通用入参（与 Nest 官方模块约定一致）。
 *
 * 用途：配置来自 `@nestjs/config` 的 `ConfigService` 或其它 provider 时，
 * 用异步工厂惰性解析配置 —— 避免在模块装饰器求值时就去读尚未加载的配置。
 *
 * @example
 * RedisModule.forRootAsync({
 *   imports: [ConfigModule],
 *   inject: [ConfigService],
 *   useFactory: (config: ConfigService) => config.get('redis', { infer: true }),
 * })
 */
export interface InfraModuleAsyncOptions<Options> {
  imports?: ModuleMetadata['imports']
  inject?: InjectionToken[]
  useFactory: (...args: any[]) => Promise<Options> | Options
}
