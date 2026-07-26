import { randomUUID } from 'node:crypto'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable, type OnApplicationShutdown } from '@nestjs/common'
import { parseJson } from '@repo/shared'
import { Redis } from 'ioredis'

const releaseLockScript = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly subscribers = new Map<string, Redis>()

  constructor(@InjectRedis() private readonly redis: Redis) {}

  get(key: string) {
    return this.redis.get(key)
  }

  set(key: string, value: string, ttlSeconds?: number) {
    if (ttlSeconds != null) return this.redis.set(key, value, 'EX', ttlSeconds)
    return this.redis.set(key, value)
  }

  del(...keys: string[]) {
    return this.redis.del(...keys)
  }

  exists(...keys: string[]) {
    return this.redis.exists(...keys)
  }

  expire(key: string, seconds: number) {
    return this.redis.expire(key, seconds)
  }

  ttl(key: string) {
    return this.redis.ttl(key)
  }

  incr(key: string) {
    return this.redis.incr(key)
  }

  incrby(key: string, increment: number) {
    return this.redis.incrby(key, increment)
  }

  sadd(key: string, ...members: string[]) {
    return this.redis.sadd(key, ...members)
  }

  srem(key: string, ...members: string[]) {
    return this.redis.srem(key, ...members)
  }

  smembers(key: string) {
    return this.redis.smembers(key)
  }

  sismember(key: string, member: string) {
    return this.redis.sismember(key, member)
  }

  scard(key: string) {
    return this.redis.scard(key)
  }

  lpush(key: string, ...values: string[]) {
    return this.redis.lpush(key, ...values)
  }

  rpush(key: string, ...values: string[]) {
    return this.redis.rpush(key, ...values)
  }

  lpop(key: string) {
    return this.redis.lpop(key)
  }

  rpop(key: string) {
    return this.redis.rpop(key)
  }

  lrange(key: string, start: number, stop: number) {
    return this.redis.lrange(key, start, stop)
  }

  llen(key: string) {
    return this.redis.llen(key)
  }

  lrem(key: string, count: number, value: string) {
    return this.redis.lrem(key, count, value)
  }

  lindex(key: string, index: number) {
    return this.redis.lindex(key, index)
  }

  lset(key: string, index: number, value: string) {
    return this.redis.lset(key, index, value)
  }

  ltrim(key: string, start: number, stop: number) {
    return this.redis.ltrim(key, start, stop)
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    const token = randomUUID()
    const result = await this.redis.set(key, token, 'EX', ttlSeconds, 'NX')
    return result === 'OK' ? token : null
  }

  async releaseLock(key: string, token: string): Promise<boolean> {
    const result = await this.redis.eval(releaseLockScript, 1, key, token)
    return result === 1
  }

  publish(channel: string, message: string) {
    return this.redis.publish(channel, message)
  }

  async subscribe(
    channel: string,
    listener: (message: string) => void,
  ): Promise<void> {
    await this.unsubscribe(channel)
    const subscriber = new Redis(this.redis.options)
    subscriber.on('message', (receivedChannel, message) => {
      if (receivedChannel === channel) listener(message)
    })
    await subscriber.subscribe(channel)
    this.subscribers.set(channel, subscriber)
  }

  async unsubscribe(channel: string): Promise<void> {
    const subscriber = this.subscribers.get(channel)
    if (!subscriber) return
    this.subscribers.delete(channel)
    await subscriber.unsubscribe(channel)
    await subscriber.quit()
  }

  hget(key: string, field: string) {
    return this.redis.hget(key, field)
  }

  hset(key: string, field: string, value: string) {
    return this.redis.hset(key, field, value)
  }

  hgetall(key: string) {
    return this.redis.hgetall(key)
  }

  hdel(key: string, ...fields: string[]) {
    return this.redis.hdel(key, ...fields)
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key)
    return raw == null ? null : parseJson<T | null>(raw, null)
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds)
  }

  get client() {
    return this.redis
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      [...this.subscribers.values()].map((subscriber) => subscriber.quit()),
    )
    this.subscribers.clear()
  }
}
