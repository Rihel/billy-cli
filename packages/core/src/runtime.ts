import { Layer } from 'effect'
import { TodoRepositoryLive } from './modules/todo/capabilities/todo.repository.js'
import { UserRepositoryLive } from './modules/user/capabilities/user.repository.js'
import { ApplicationLoggerLive } from './shared/application-logger.capability.js'
import { DbLive } from './shared/database.capability.js'
import { ObjectStorageLive } from './shared/object-storage/object-storage.capability.js'
import { PasswordHasherLive } from './shared/password-hasher.capability.js'
import { RedisStoreLive } from './shared/redis-store.capability.js'
import {
  makeConfigLayer,
  type RuntimeConfigInput,
} from './shared/runtime-config.js'
import { TokenSignerLive } from './shared/token-signer.capability.js'
import { IdGenerationLive } from './shared/id-generation.capability.js'

export {
  DbLive,
  TokenSignerLive,
  ApplicationLoggerLive,
  ObjectStorageLive,
  PasswordHasherLive,
  RedisStoreLive,
  IdGenerationLive,
  TodoRepositoryLive,
  UserRepositoryLive,
}

const IndependentSharedLive = Layer.mergeAll(
  DbLive,
  TokenSignerLive,
  ApplicationLoggerLive,
  PasswordHasherLive,
  IdGenerationLive,
)

const RedisStoreProvidedLive = RedisStoreLive.pipe(
  Layer.provide(IdGenerationLive),
)

export const SharedLive = Layer.merge(
  IndependentSharedLive,
  RedisStoreProvidedLive,
)

export const RepositoriesLive = Layer.mergeAll(
  UserRepositoryLive,
  TodoRepositoryLive,
).pipe(Layer.provide(DbLive))

export const CapabilitiesLive = Layer.merge(SharedLive, RepositoriesLive)

export const ObjectStorageProvidedLive = ObjectStorageLive.pipe(
  Layer.provide(SharedLive),
)

export const RuntimeLive = Layer.mergeAll(
  CapabilitiesLive,
  ObjectStorageProvidedLive,
)

export const makeRuntimeLayer = (config: RuntimeConfigInput) =>
  RuntimeLive.pipe(Layer.provide(makeConfigLayer(config)))
