import { Inject, Injectable, Scope } from '@nestjs/common'
import { INQUIRER } from '@nestjs/core'
import { createLogger, type AppLogger } from '@repo/shared/logger'
import { LOGGER_MODULE_OPTIONS, type LoggerModuleOptions } from './options.js'

@Injectable({ scope: Scope.TRANSIENT })
export class AppLoggerService implements AppLogger {
  private readonly logger: AppLogger

  constructor(
    @Inject(INQUIRER) parentClass: object,
    @Inject(LOGGER_MODULE_OPTIONS) options: LoggerModuleOptions,
  ) {
    const name = parentClass?.constructor?.name ?? 'App'
    this.logger = createLogger(name, options.pretty)
  }

  setContext(context: string) {
    this.logger.setContext(context)
  }

  log(message?: string, data?: unknown) {
    this.logger.log(message, data)
  }

  info(message?: string, data?: unknown) {
    this.logger.info(message, data)
  }

  warn(message?: string, data?: unknown) {
    this.logger.warn(message, data)
  }

  debug(message?: string, data?: unknown) {
    this.logger.debug(message, data)
  }

  error(message?: string, data?: unknown) {
    this.logger.error(message, data)
  }
}
