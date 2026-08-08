import { Config, Context, Effect, Layer, Option } from 'effect'
import { ApplicationLogger } from '../application-logger.capability.js'
import { RedisStore } from '../redis-store.capability.js'
import { ObjectStorageError } from '../infrastructure-errors.js'
import { makePromiseAdapter, tryPromise } from '../effect-adapters.js'
import { makeCosProvider } from './cos.js'
import { makeS3Provider } from './s3.js'
import type { ObjectStorageConfig } from './types.js'
import type {
  ObjectContent,
  ObjectKey,
  ObjectRemoved,
  PresignedObjectUrl,
  TemporaryCredentials,
  TemporaryCredentialsRequest,
  UploadObject,
} from './domain.js'

export interface ObjectStorageApi {
  getPresignedUrl(
    data: UploadObject,
  ): Effect.Effect<PresignedObjectUrl, ObjectStorageError>
  getDownloadUrl(
    key: ObjectKey,
  ): Effect.Effect<PresignedObjectUrl, ObjectStorageError>
  getTemporaryCredentials(
    request: TemporaryCredentialsRequest,
  ): Effect.Effect<TemporaryCredentials, ObjectStorageError>
  getObject(key: ObjectKey): Effect.Effect<ObjectContent, ObjectStorageError>
  removeObject(key: ObjectKey): Effect.Effect<ObjectRemoved, ObjectStorageError>
}

export class ObjectStorage extends Context.Tag('ObjectStorage')<
  ObjectStorage,
  ObjectStorageApi
>() {}

export const ObjectStorageLive = Layer.scoped(
  ObjectStorage,
  Effect.gen(function* () {
    const provider = yield* Config.literal(
      's3',
      'cos',
    )('OBJECT_STORAGE_PROVIDER').pipe(Config.withDefault('s3'))
    const region = yield* Config.string('OBJECT_STORAGE_REGION').pipe(
      Config.withDefault('us-east-1'),
    )
    const bucket = yield* Config.string('OBJECT_STORAGE_BUCKET')
    const accessKeyId = yield* Config.string('OBJECT_STORAGE_ACCESS_KEY_ID')
    const secretAccessKey = yield* Config.string(
      'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    )
    const endpoint = yield* Config.string('OBJECT_STORAGE_ENDPOINT').pipe(
      Config.option,
      Effect.map(Option.getOrUndefined),
    )
    const config: ObjectStorageConfig = {
      provider,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      endpoint,
    }
    const logger = yield* ApplicationLogger
    const redis = yield* RedisStore
    const selected =
      provider === 's3'
        ? makeS3Provider(config, logger, redis)
        : makeCosProvider(config, logger)
    const current = yield* Effect.acquireRelease(
      tryPromise(
        async () => {
          await selected.initial()
          return selected
        },
        (cause) => new ObjectStorageError({ operation: 'initial', cause }),
      ),
      () => Effect.void,
    )
    const fromPromise = (operation: string) =>
      makePromiseAdapter(
        (cause) => new ObjectStorageError({ operation, cause }),
      )
    return {
      getPresignedUrl: (data) =>
        fromPromise('getPresignedUrl')(() => current.getPresignedUrl(data)),
      getDownloadUrl: (key) =>
        fromPromise('getDownloadUrl')(() => current.getDownloadUrl(key)),
      getTemporaryCredentials: (request) =>
        fromPromise('getTemporaryCredentials')(() =>
          current.getTemporaryCredentials(request),
        ),
      getObject: (key) =>
        fromPromise('getObject')(() => current.getObject(key)),
      removeObject: (key) =>
        fromPromise('removeObject')(() => current.removeObject(key)),
    }
  }),
)
