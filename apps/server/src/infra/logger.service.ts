import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import { type AppLogger, createLogger } from '@repo/shared/logger';
import { appConfig } from '../config.js';

@Injectable({ scope: Scope.TRANSIENT })
export class AppLoggerService implements AppLogger {
  private readonly logger: AppLogger;

  constructor(@Inject(INQUIRER) parentClass: object) {
    const name = parentClass?.constructor?.name ?? 'App';
    this.logger = createLogger(name, appConfig.isDev);
  }

  setContext(context: string) {
    this.logger.setContext(context);
  }
  log(message?: string, data?: unknown) {
    this.logger.log(message, data);
  }
  info(message?: string, data?: unknown) {
    this.logger.info(message, data);
  }
  warn(message?: string, data?: unknown) {
    this.logger.warn(message, data);
  }
  debug(message?: string, data?: unknown) {
    this.logger.debug(message, data);
  }
  error(message?: string, data?: unknown) {
    this.logger.error(message, data);
  }
}
