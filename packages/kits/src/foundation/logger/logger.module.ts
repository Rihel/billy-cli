import { Global, Module, type DynamicModule } from '@nestjs/common'
import { createLogger } from '@repo/shared/logger'
import type { z } from 'zod'
import {
  LoggerConfig as LoggerConfigToken,
  LoggerConfigSchema,
  resolvePretty,
  type LoggerConfig,
} from './logger.config.js'
import { buildPinoOptions } from './logger.options.js'
import { LOGGER_INSTANCE } from './logger.providers.js'
import { AppLogger } from './app-logger.js'
import { NestLoggerAdapter } from './nest-logger.js'
import type { InfraModuleAsyncOptions } from '../infra-module.js'

/** LoggerModule.forRoot 入参 = LoggerConfigSchema 的输入类型 */
export type LoggerModuleOptions = z.input<typeof LoggerConfigSchema>

/** 用应用配置建出**唯一**的基础日志门面（含 transport，只建一次） */
const createLoggerInstance = (config: LoggerConfig) =>
  createLogger(
    config.prefix,
    resolvePretty(config),
    config.level,
    buildPinoOptions(config),
  )

/**
 * 日志模块（自建，不依赖 nestjs-pino）：
 *
 * - 用 `@repo/shared/logger` 的 `createLogger` 建**一个** pino 实例（pretty / 落盘 / Loki 由
 *   `buildPinoOptions` 决定），并以 `LOGGER_INSTANCE` 暴露；
 * - 提供可注入的 `AppLogger`（TRANSIENT + INQUIRER，context 取宿主类名）与
 *   `NestLoggerAdapter`（Nest `LoggerService` 适配，供 `app.useLogger` 接管框架日志）；
 * - **不再提供 pino-http 请求日志**：请求日志改由 `apps/server` 的
 *   `RequestLoggerMiddleware` 自己记录（它能直接读请求上下文 ALS，见该中间件注释）。
 *
 * 应用侧用法：
 *   const app = await NestFactory.create(RootModule, { bufferLogs: true })
 *   app.useLogger(app.get(NestLoggerAdapter))
 */
@Global()
@Module({})
export class LoggerModule {
  static forRoot(options: LoggerModuleOptions = {}): DynamicModule {
    const config = LoggerConfigSchema.parse(options)
    return {
      module: LoggerModule,
      providers: [
        { provide: LoggerConfigToken, useValue: config },
        { provide: LOGGER_INSTANCE, useFactory: () => createLoggerInstance(config) },
        AppLogger,
        NestLoggerAdapter,
      ],
      exports: [LoggerConfigToken, LOGGER_INSTANCE, AppLogger, NestLoggerAdapter],
    }
  }

  /** 异步装配：配置由注入的 provider（如 ConfigService）惰性解析 */
  static forRootAsync(
    options: InfraModuleAsyncOptions<LoggerModuleOptions>,
  ): DynamicModule {
    return {
      module: LoggerModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: LoggerConfigToken,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        {
          provide: LOGGER_INSTANCE,
          inject: [LoggerConfigToken],
          useFactory: (raw: LoggerModuleOptions) =>
            createLoggerInstance(LoggerConfigSchema.parse(raw)),
        },
        AppLogger,
        NestLoggerAdapter,
      ],
      exports: [LoggerConfigToken, LOGGER_INSTANCE, AppLogger, NestLoggerAdapter],
    }
  }
}
