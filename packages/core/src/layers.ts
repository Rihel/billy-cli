import { Layer } from 'effect'
import type { AppError } from './errors.js'
import {
  ConfigService,
  makeConfigLayer,
  ConfigServiceLive,
  type AppConfigInput,
} from './infra/config.service.js'
import { DbService, DbServiceLive } from './infra/db.service.js'
import { LoggerService, LoggerServiceLive } from './infra/logger.service.js'
import { JwtService, JwtServiceLive } from './infra/jwt.service.js'
import {
  PasswordService,
  PasswordServiceLive,
} from './infra/password.service.js'
import { RedisService, RedisServiceLive } from './infra/redis.service.js'
import {
  StorageService,
  StorageServiceLive,
} from './infra/storage/storage.service.js'
import { AuthService, AuthServiceLive } from './biz/auth.service.js'
import { TodoService, TodoServiceLive } from './biz/todo.service.js'
import { UserService, UserServiceLive } from './biz/user.service.js'

type AppServices =
  | ConfigService
  | DbService
  | LoggerService
  | JwtService
  | PasswordService
  | RedisService
  | StorageService
  | AuthService
  | TodoService
  | UserService

/**
 * Build the full application layer from a plain config object.
 * Zod validates and fills defaults. Pass result to ManagedRuntime.make().
 *
 * @example Hardcoded config
 * makeAppLayer({ db: { url: 'postgres://...' }, jwt: { secret: '...' }, storage: { ... } })
 *
 * @example From env (default)
 * makeAppLayer() // uses process.env
 */
export function makeAppLayer(
  config?: AppConfigInput,
): Layer.Layer<AppServices, Error | AppError, never> {
  const ConfigLayer = config ? makeConfigLayer(config) : ConfigServiceLive

  const InfraLayer = Layer.mergeAll(
    DbServiceLive,
    LoggerServiceLive,
    JwtServiceLive,
    PasswordServiceLive,
    RedisServiceLive,
  ).pipe(Layer.provide(ConfigLayer))

  const Dependencies = Layer.merge(ConfigLayer, InfraLayer)
  const StorageLayer = StorageServiceLive.pipe(Layer.provide(Dependencies))
  const BizLayer = Layer.mergeAll(
    AuthServiceLive,
    TodoServiceLive,
    UserServiceLive,
  ).pipe(Layer.provide(Dependencies))

  return Layer.mergeAll(Dependencies, StorageLayer, BizLayer)
}

export { ConfigServiceLive }
