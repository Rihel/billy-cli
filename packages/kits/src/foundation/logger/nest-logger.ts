import { Inject, Injectable, type LoggerService } from '@nestjs/common'
import type { CreateLoggerResult } from '@repo/shared/logger'
import { LOGGER_INSTANCE } from './logger.providers.js'

/**
 * Nest 框架日志适配器（替代 nestjs-pino 的 `Logger`）。
 *
 * 用 `app.useLogger(app.get(NestLoggerAdapter))` 接管 Nest 自身日志
 * （InstanceLoader / RoutesResolver / 未捕获异常等），使其与业务日志走同一个 pino 实例与
 * transport（pretty / 落盘 / Loki），不用再为框架日志单开一条输出通道。
 *
 * Nest 的调用约定是 `(message, ...optionalParams)`，其中最后一个字符串参数通常是 context
 * （如 `log('Mapped {/x, POST} route', 'RouterExplorer')`）；这里据此取 context，其余参数
 * 作为结构化数据带上。
 */
@Injectable()
export class NestLoggerAdapter implements LoggerService {
  /** context → 子 logger 缓存（child 很轻，但没必要每次日志都新建） */
  private readonly children = new Map<string, CreateLoggerResult>()

  constructor(@Inject(LOGGER_INSTANCE) private readonly base: CreateLoggerResult) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams)
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams)
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams)
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams)
  }

  /** Nest 的 verbose 归到 debug（pino 无 verbose 级别） */
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams)
  }

  private write(
    level: 'info' | 'warn' | 'error' | 'debug',
    message: unknown,
    optionalParams: unknown[],
  ): void {
    const context =
      [...optionalParams].reverse().find((param): param is string => typeof param === 'string') ??
      'Nest'

    let logger = this.children.get(context)
    if (!logger) {
      logger = this.base.child(context)
      this.children.set(context, logger)
    }

    const text =
      typeof message === 'string'
        ? message
        : message instanceof Error
          ? message.message
          : String(message)

    // 除 context 外的附加参数（错误堆栈等）作为结构化数据带上
    const extra = optionalParams.filter((param) => param !== context)
    if (message instanceof Error && message.stack) extra.push(message.stack)
    logger[level](text, extra.length > 0 ? { params: extra } : undefined)
  }
}
