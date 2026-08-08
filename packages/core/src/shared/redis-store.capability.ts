import { Config, Context, Effect, Layer, Option } from 'effect'
import { Redis as RedisClient } from 'ioredis'
import { RedisStoreError } from './infrastructure-errors.js'
import { makePromiseAdapter, tryPromise } from './effect-adapters.js'
import { IdGeneration, IdGenerationApi } from './id-generation.capability.js'

const releaseLockScript = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

export interface RedisStoreApi {
  readonly raw: RedisClient
  get(key: string): Effect.Effect<string | null, RedisStoreError>
  set(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Effect.Effect<string | null, RedisStoreError>
  del(...keys: string[]): Effect.Effect<number, RedisStoreError>
  exists(...keys: string[]): Effect.Effect<number, RedisStoreError>
  expire(key: string, seconds: number): Effect.Effect<boolean, RedisStoreError>
  ttl(key: string): Effect.Effect<number, RedisStoreError>
  incr(key: string): Effect.Effect<number, RedisStoreError>
  getJson<T>(key: string): Effect.Effect<T | null, RedisStoreError>
  setJson<T>(
    key: string,
    value: T,
    ttlSeconds?: number,
  ): Effect.Effect<void, RedisStoreError>
  acquireLock(
    key: string,
    ttlSeconds: number,
  ): Effect.Effect<string | null, RedisStoreError>
  releaseLock(
    key: string,
    token: string,
  ): Effect.Effect<boolean, RedisStoreError>
}

export class RedisStore extends Context.Tag('RedisStore')<
  RedisStore,
  RedisStoreApi
>() {}

const makeRedis = (
  client: RedisClient,
  idGeneration: IdGenerationApi,
): RedisStoreApi => {
  const fromPromise = makePromiseAdapter(
    (cause) => new RedisStoreError({ cause }),
  )

  return {
    raw: client,
    get: (key) => fromPromise(() => client.get(key)),
    set: (key, value, ttlSeconds) =>
      fromPromise(() =>
        ttlSeconds === undefined
          ? client.set(key, value)
          : client.set(key, value, 'EX', ttlSeconds),
      ),
    del: (...keys) => fromPromise(() => client.del(...keys)),
    exists: (...keys) => fromPromise(() => client.exists(...keys)),
    expire: (key, seconds) =>
      fromPromise(() => client.expire(key, seconds).then(Boolean)),
    ttl: (key) => fromPromise(() => client.ttl(key)),
    incr: (key) => fromPromise(() => client.incr(key)),
    getJson: <T>(key: string) =>
      fromPromise(async () => {
        const value = await client.get(key)
        return value === null ? null : (JSON.parse(value) as T)
      }),
    setJson: <T>(key: string, value: T, ttlSeconds?: number) =>
      fromPromise(async () => {
        if (ttlSeconds === undefined)
          await client.set(key, JSON.stringify(value))
        else await client.set(key, JSON.stringify(value), 'EX', ttlSeconds)
      }),
    acquireLock: (key, ttlSeconds) =>
      fromPromise(async () => {
        const token = idGeneration.next()
        const result = await client.set(key, token, 'EX', ttlSeconds, 'NX')
        return result === 'OK' ? token : null
      }),
    releaseLock: (key, token) =>
      fromPromise(async () =>
        Boolean(await client.eval(releaseLockScript, 1, key, token)),
      ),
  }
}

export const RedisStoreLive = Layer.scoped(
  RedisStore,
  Effect.gen(function* () {
    const idGeneration = yield* IdGeneration
    const url = yield* Config.string('REDIS_URL').pipe(
      Config.withDefault('redis://localhost:6379/0'),
    )
    const keyPrefix = yield* Config.string('REDIS_KEY_PREFIX').pipe(
      Config.option,
      Effect.map(Option.getOrUndefined),
    )
    return yield* Effect.acquireRelease(
      tryPromise(
        async () => {
          const client = new RedisClient(url, { keyPrefix, lazyConnect: true })
          await client.connect()
          return makeRedis(client, idGeneration)
        },
        (cause) => new RedisStoreError({ cause }),
      ),
      ({ raw }) => Effect.promise(() => raw.quit().then(() => undefined)),
    )
  }),
)
