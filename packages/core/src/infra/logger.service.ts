import { Context, Effect, Layer } from 'effect'
import { createLogger } from '@repo/shared/logger'
import { ConfigService } from './config.service.js'

export interface ILogger {
  log(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

export class LoggerService extends Context.Tag('LoggerService')<LoggerService, ILogger>() {}

export const LoggerServiceLive = Layer.effect(
  LoggerService,
  Effect.gen(function* () {
    const { logger } = yield* ConfigService
    return createLogger(logger.name ?? 'app', logger.pretty)
  }),
)
