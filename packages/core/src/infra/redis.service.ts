import { randomUUID } from 'node:crypto'
import { Context, Effect, Layer } from 'effect'
import { Redis } from 'ioredis'
import { parseJson } from '@repo/shared'
import { ConfigService } from './config.service.js'

const releaseLockScript = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

// ── IRedis: fully Effect-native interface ─────────────────────────────────────

export interface IRedis {
  // String
  get(key: string): Effect.Effect<string | null>
  set(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Effect.Effect<string | null>
  del(...keys: string[]): Effect.Effect<number>
  exists(...keys: string[]): Effect.Effect<number>
  expire(key: string, seconds: number): Effect.Effect<boolean>
  ttl(key: string): Effect.Effect<number>
  incr(key: string): Effect.Effect<number>
  incrby(key: string, increment: number): Effect.Effect<number>

  // Set
  sadd(key: string, ...members: string[]): Effect.Effect<number>
  srem(key: string, ...members: string[]): Effect.Effect<number>
  smembers(key: string): Effect.Effect<string[]>
  sismember(key: string, member: string): Effect.Effect<number>
  scard(key: string): Effect.Effect<number>

  // List
  lpush(key: string, ...values: string[]): Effect.Effect<number>
  rpush(key: string, ...values: string[]): Effect.Effect<number>
  lpop(key: string): Effect.Effect<string | null>
  rpop(key: string): Effect.Effect<string | null>
  lrange(key: string, start: number, stop: number): Effect.Effect<string[]>
  llen(key: string): Effect.Effect<number>
  lrem(key: string, count: number, value: string): Effect.Effect<number>
  lindex(key: string, index: number): Effect.Effect<string | null>
  lset(key: string, index: number, value: string): Effect.Effect<string>
  ltrim(key: string, start: number, stop: number): Effect.Effect<string>

  // Hash
  hget(key: string, field: string): Effect.Effect<string | null>
  hset(key: string, field: string, value: string): Effect.Effect<number>
  hgetall(key: string): Effect.Effect<Record<string, string> | null>
  hdel(key: string, ...fields: string[]): Effect.Effect<number>

  // Pub/Sub
  publish(channel: string, message: string): Effect.Effect<number>
  subscribe(
    channel: string,
    listener: (message: string) => void,
  ): Effect.Effect<void>
  unsubscribe(channel: string): Effect.Effect<void>

  // Distributed lock
  acquireLock(key: string, ttlSeconds: number): Effect.Effect<string | null>
  releaseLock(key: string, token: string): Effect.Effect<boolean>

  // JSON helpers
  getJson<T>(key: string): Effect.Effect<T | null>
  setJson<T>(key: string, value: T, ttlSeconds?: number): Effect.Effect<void>

  // Raw client (escape hatch)
  readonly raw: Redis
}

export class RedisService extends Context.Tag('RedisService')<
  RedisService,
  IRedis
>() {}

// ── RedisServiceLive ──────────────────────────────────────────────────────────

export interface RedisConfig {
  url: string
  keyPrefix?: string
}

function buildIRedis(redis: Redis): IRedis {
  const subscribers = new Map<string, Redis>()
  const p = <T>(fn: () => Promise<T>) => Effect.promise(fn)

  return {
    raw: redis,

    get: (k) => p(() => redis.get(k)),
    set: (k, v, ttl) =>
      p(() => (ttl != null ? redis.set(k, v, 'EX', ttl) : redis.set(k, v))),
    del: (...keys) => p(() => redis.del(...keys)),
    exists: (...keys) => p(() => redis.exists(...keys)),
    expire: (k, s) => p(() => redis.expire(k, s).then(Boolean)),
    ttl: (k) => p(() => redis.ttl(k)),
    incr: (k) => p(() => redis.incr(k)),
    incrby: (k, n) => p(() => redis.incrby(k, n)),

    sadd: (k, ...m) => p(() => redis.sadd(k, ...m)),
    srem: (k, ...m) => p(() => redis.srem(k, ...m)),
    smembers: (k) => p(() => redis.smembers(k)),
    sismember: (k, m) => p(() => redis.sismember(k, m)),
    scard: (k) => p(() => redis.scard(k)),

    lpush: (k, ...v) => p(() => redis.lpush(k, ...v)),
    rpush: (k, ...v) => p(() => redis.rpush(k, ...v)),
    lpop: (k) => p(() => redis.lpop(k)),
    rpop: (k) => p(() => redis.rpop(k)),
    lrange: (k, s, e) => p(() => redis.lrange(k, s, e)),
    llen: (k) => p(() => redis.llen(k)),
    lrem: (k, c, v) => p(() => redis.lrem(k, c, v)),
    lindex: (k, i) => p(() => redis.lindex(k, i)),
    lset: (k, i, v) => p(() => redis.lset(k, i, v)),
    ltrim: (k, s, e) => p(() => redis.ltrim(k, s, e)),

    hget: (k, f) => p(() => redis.hget(k, f)),
    hset: (k, f, v) => p(() => redis.hset(k, f, v)),
    hgetall: (k) => p(() => redis.hgetall(k)),
    hdel: (k, ...f) => p(() => redis.hdel(k, ...f)),

    publish: (ch, msg) => p(() => redis.publish(ch, msg)),

    subscribe: (channel, listener) =>
      Effect.promise(async () => {
        const existing = subscribers.get(channel)
        if (existing) {
          await existing.unsubscribe(channel)
          await existing.quit()
          subscribers.delete(channel)
        }
        const sub = new Redis(redis.options)
        sub.on('message', (ch, msg) => {
          if (ch === channel) listener(msg)
        })
        await sub.subscribe(channel)
        subscribers.set(channel, sub)
      }),

    unsubscribe: (channel) =>
      Effect.promise(async () => {
        const sub = subscribers.get(channel)
        if (!sub) return
        subscribers.delete(channel)
        await sub.unsubscribe(channel)
        await sub.quit()
      }),

    acquireLock: (k, ttl) =>
      p(async () => {
        const token = randomUUID()
        const result = await redis.set(k, token, 'EX', ttl, 'NX')
        return result === 'OK' ? token : null
      }),

    releaseLock: (k, token) =>
      p(async () => {
        const result = await redis.eval(releaseLockScript, 1, k, token)
        return result === 1
      }),

    getJson: <T>(k: string) =>
      p(async () => {
        const raw = await redis.get(k)
        return raw == null ? null : parseJson<T | null>(raw, null)
      }),

    setJson: <T>(k: string, v: T, ttl?: number) =>
      p(async () => {
        await (ttl != null
          ? redis.set(k, JSON.stringify(v), 'EX', ttl)
          : redis.set(k, JSON.stringify(v)))
      }),
  }
}

export const RedisServiceLive = Layer.scoped(
  RedisService,
  Effect.gen(function* () {
    const { redis } = yield* ConfigService
    return yield* Effect.acquireRelease(
      Effect.sync(() =>
        buildIRedis(
          new Redis(redis.url, {
            keyPrefix: redis.keyPrefix,
            lazyConnect: true,
          }),
        ),
      ),
      (iRedis) => Effect.promise(() => iRedis.raw.quit().then(() => {})),
    )
  }),
)
