import { Global, Module, type DynamicModule } from '@nestjs/common'
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino'
import type { z } from 'zod'
import { LoggerConfigSchema as LoggerSchema } from './logger.config.js'
import {
  LoggerConfig as LoggerConfigToken,
  LoggerConfigSchema,
} from './logger.config.js'
import type { LoggerHttpOptions } from './logger.options.js'
import { buildLoggerParams } from './logger.options.js'
import { AppLogger } from './app-logger.js'
import type { InfraModuleAsyncOptions } from '../infra-module.js'

/** LoggerModule.forRoot 入参：zod 配置分片（输入类型，带默认值的字段可省略）+ pino-http 定制点 */
export type LoggerModuleOptions = z.input<typeof LoggerSchema> & LoggerHttpOptions

/**
 * 日志模块（对齐 rihel-base 的 LoggerModule）：
 *
 * - 内部委托 nestjs-pino 的 `LoggerModule.forRoot`：pino-http 自动记录每次请求/响应
 *   （含状态码、耗时、req.id），并按状态码分级（<400 info / 4xx warn / 5xx error）；
 * - 生产 + 配置 loki → 多目标 transport（落盘 + 推送 Loki）；非生产 → pino-pretty；
 * - 提供可注入的 `AppLogger`（TRANSIENT + INQUIRER，context 取宿主类名），
 *   统一 Nest 内部日志（`app.useLogger`）与业务日志的输出通道与 transport。
 *
 * 应用侧用法：
 *   const app = await NestFactory.create(RootModule, { bufferLogs: true })
 *   app.useLogger(app.get(Logger))   // nestjs-pino 的 Logger
 */
@Global()
@Module({})
export class LoggerModule {
  static forRoot(options: LoggerModuleOptions = {}): DynamicModule {
    const { customProps, genReqId, ...configInput } = options
    const config = LoggerConfigSchema.parse(configInput)
    const http: LoggerHttpOptions = { customProps, genReqId }

    return {
      module: LoggerModule,
      imports: [PinoLoggerModule.forRoot(buildLoggerParams(config, http))],
      providers: [
        { provide: LoggerConfigToken, useValue: config },
        AppLogger,
      ],
      exports: [LoggerConfigToken, AppLogger, PinoLoggerModule],
    }
  }

  /** 异步装配：配置由注入的 provider（如 ConfigService）惰性解析 */
  static forRootAsync(
    options: InfraModuleAsyncOptions<LoggerModuleOptions>,
  ): DynamicModule {
    return {
      module: LoggerModule,
      imports: [
        PinoLoggerModule.forRootAsync({
          imports: options.imports ?? [],
          inject: options.inject ?? [],
          useFactory: async (...args: unknown[]) => {
            const resolved = await options.useFactory(...args)
            const { customProps, genReqId, ...configInput } = resolved
            return buildLoggerParams(LoggerConfigSchema.parse(configInput), {
              customProps,
              genReqId,
            })
          },
        }),
      ],
      providers: [
        {
          provide: LoggerConfigToken,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        AppLogger,
      ],
      exports: [LoggerConfigToken, AppLogger, PinoLoggerModule],
    }
  }

}
