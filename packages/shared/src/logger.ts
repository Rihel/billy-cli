import pino from 'pino'

export type LogFunction = (message?: string, data?: unknown) => void

export interface AppLogger {
  setContext(context: string): void
  log: LogFunction
  info: LogFunction
  warn: LogFunction
  debug: LogFunction
  error: LogFunction
}

export function createLogger(name: string) {
  const logger = pino({
    name,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  })
  return {
    setContext(context: string) {
      logger.child({ context })
    },
    log: (message?: string, data?: any) => {
      if (typeof data === 'string') {
        message = `${data} ${message}`
        data = {}
      }

      logger.info(data, message)
    },
    info: (message?: string, data?: any) => {
      if (typeof data === 'string') {
        message = `${data} ${message}`
        data = {}
      }

      logger.info(data, message)
    },
    warn: (message?: string, data?: any) => {
      if (typeof data === 'string') {
        message = `${data} ${message}`
        data = {}
      }

      logger.warn(data, message)
    },
    debug: (message?: string, data?: any) => {
      if (typeof data === 'string') {
        message = `${data} ${message}`
        data = {}
      }

      logger.debug(data, message)
    },
    error: (message?: string, data?: any) => {
      if (typeof data === 'string') {
        message = `${data} ${message}`
        data = {}
      }

      logger.error(data, message)
    },
  }
}
