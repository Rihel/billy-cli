import { createLogger, type AppLogger } from '@repo/shared/logger'

let loggerPretty = false

/** 由 createAppContext 设置（config.logger.pretty）。 */
export const configureLogger = (pretty: boolean): void => {
  loggerPretty = pretty
}

/**
 * 成员变量日志装饰器：自动以宿主类名创建 logger（首次访问时惰性创建并缓存）。
 *
 * @example
 * @injectable()
 * export class AuthService {
 *   @Logger()
 *   private readonly logger!: AppLogger
 * }
 */
export const Logger = () =>
  function (target: object, propertyKey: string | symbol): void {
    Object.defineProperty(target, propertyKey, {
      configurable: true,
      enumerable: false,
      get(this: Record<string, unknown>) {
        const name = (this.constructor as { name: string }).name
        const logger = createLogger(name, loggerPretty)
        Object.defineProperty(this, propertyKey, {
          value: logger,
          writable: true,
          configurable: true,
        })
        return logger
      },
    })
  }
