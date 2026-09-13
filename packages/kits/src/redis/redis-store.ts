import { AppLogger } from '../foundation/logger/app-logger.js'
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common'
import { Redis as RedisClient } from 'ioredis'
import { RedisConfig } from './redis.config.js'
import { IdGeneration } from '../foundation/id-generation/id-generation.js'
import { RedisStoreError } from '../foundation/errors/infrastructure-errors.js'

const releaseLockScript = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`


@Injectable()
export class RedisStore implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly raw: RedisClient


  private readonly idGeneration: IdGeneration

  constructor(
    @Inject(RedisConfig) config: RedisConfig,
    @Inject(IdGeneration) idGeneration: IdGeneration,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.idGeneration = idGeneration
    const url = config.url
    const keyPrefix = config.keyPrefix
    this.logger.info('正在链接Redis', { url, keyPrefix })
    this.raw = new RedisClient(url, { keyPrefix, lazyConnect: true })
    this.raw.on('error', (error) => {
      this.logger.error('Redis 连接错误', { error })
    })
  }

  private async fromPromise<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }

  get(key: string): Promise<string | null> {
    return this.fromPromise(() => this.raw.get(key))
  }

  set(key: string, value: string, ttlSeconds?: number): Promise<string | null> {
    return this.fromPromise(() =>
      ttlSeconds === undefined
        ? this.raw.set(key, value)
        : this.raw.set(key, value, 'EX', ttlSeconds),
    )
  }

  del(...keys: string[]): Promise<number> {
    return this.fromPromise(() => this.raw.del(...keys))
  }

  exists(...keys: string[]): Promise<number> {
    return this.fromPromise(() => this.raw.exists(...keys))
  }

  expire(key: string, seconds: number): Promise<boolean> {
    return this.fromPromise(() => this.raw.expire(key, seconds).then(Boolean))
  }

  ttl(key: string): Promise<number> {
    return this.fromPromise(() => this.raw.ttl(key))
  }

  incr(key: string): Promise<number> {
    return this.fromPromise(() => this.raw.incr(key))
  }

  getJson<T>(key: string): Promise<T | null> {
    return this.fromPromise(async () => {
      const value = await this.raw.get(key)
      return value === null ? null : (JSON.parse(value) as T)
    })
  }

  setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    return this.fromPromise(async () => {
      if (ttlSeconds === undefined) await this.raw.set(key, JSON.stringify(value))
      else await this.raw.set(key, JSON.stringify(value), 'EX', ttlSeconds)
    })
  }

  acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    return this.fromPromise(async () => {
      const token = this.idGeneration.next()
      const result = await this.raw.set(key, token, 'EX', ttlSeconds, 'NX')
      return result === 'OK' ? token : null
    })
  }

  releaseLock(key: string, token: string): Promise<boolean> {
    return this.fromPromise(async () =>
      Boolean(await this.raw.eval(releaseLockScript, 1, key, token)),
    )
  }

  /** 应用启动：建立 Redis 连接（lazyConnect 下首次显式连接）。 */
  async onApplicationBootstrap(): Promise<void> {
    await this.raw.connect()
  }

  /** 应用停止：断开 Redis 连接。 */
  async onApplicationShutdown(): Promise<void> {
    await this.close()
  }

  async close(): Promise<void> {
    this.logger.info('正在断开Redis连接')
    await this.raw.quit()
    this.logger.info('Redis连接已断开')
  }
}
