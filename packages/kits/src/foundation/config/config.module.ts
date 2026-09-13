import { Global, Module, type DynamicModule } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AppConfigFacade } from './config.facade.js'

/**
 * 应用配置注入 token：已加载并校验过的整份配置对象。
 * 需要按路径取值时用 `@nestjs/config` 的 `ConfigService`（如 `config.get('logger.level')`）。
 */
export const AppConfig = Symbol.for('AppConfig')

/**
 * 应用配置模块：`ConfigModule.forRoot({ isGlobal, load: [() => AppConfigFacade.getConfig()] })`
 * （`ConfigModule` 来自 `@nestjs/config`），把已加载配置接进 Nest，
 * 并提供全局 `ConfigService` 与 `AppConfig` bean。
 *
 * 前置条件：bootstrap 必须先 `await AppConfigFacade.initial({ schema, loader })`
 * （shape 由应用自定义，来源由 loader 决定）。
 *
 * @example
 * imports: [AppConfigModule.forRoot()]
 */
@Global()
@Module({})
export class AppConfigModule {
  static forRoot(): DynamicModule {
    return {
      module: AppConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [() => AppConfigFacade.getConfig()],
        }),
      ],
      providers: [
        { provide: AppConfig, useFactory: () => AppConfigFacade.getConfig() },
      ],
      // ConfigService 由全局 ConfigModule 提供（isGlobal: true），无需在此导出
      exports: [AppConfig],
    }
  }
}
