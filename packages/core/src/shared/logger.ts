import { createLogger, type AppLogger } from '@repo/shared/logger'
import { inject, injectable } from 'inversify'
import { AppConfig } from './app-config.js'


@injectable()
export class Logger {
  private readonly logger: AppLogger

  constructor(@inject(AppConfig) config: AppConfig) {
    this.logger = createLogger(config.loggerName, config.loggerPretty)
  }

  log = (message: string, data?: unknown) => {
    this.logger.log(message, data)
  }

  info = (message: string, data?: unknown) => {
    this.logger.info(message, data)
  }

  warn = (message: string, data?: unknown) => {
    this.logger.warn(message, data)
  }

  error = (message: string, data?: unknown) => {
    this.logger.error(message, data)
  }
}
