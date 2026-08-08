import { createLogger } from '@repo/shared/logger'
import { Config, Context, Effect, Layer } from 'effect'

export interface ApplicationLoggerApi {
  log(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

export class ApplicationLogger extends Context.Tag('ApplicationLogger')<
  ApplicationLogger,
  ApplicationLoggerApi
>() {}

export const ApplicationLoggerLive = Layer.effect(
  ApplicationLogger,
  Effect.gen(function* () {
    const name = yield* Config.string('LOGGER_NAME').pipe(
      Config.withDefault('app'),
    )
    const pretty = yield* Config.boolean('LOGGER_PRETTY').pipe(
      Config.withDefault(false),
    )
    return createLogger(name, pretty)
  }),
)
