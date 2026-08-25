import type { AppLogger } from '@repo/shared/logger'
import { inject, injectable } from 'inversify'
import type { OnAppStart, OnAppStop } from '../composition/life-cycle.js'
import { Redis as RedisClient } from 'ioredis'
import { AppConfig } from '../foundation/app-config.js'
import { IdGeneration } from '../foundation/id-generation.js'
import { RedisStoreError } from '../foundation/errors/infrastructure-errors.js'
import { Logger } from '../foundation/logger.js'

const releaseLockScript = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`


@injectable()
export class RedisStore implements OnAppStart, OnAppStop {
  readonly raw: RedisClient

  @Logger()
  private readonly logger!: AppLogger

  private readonly idGeneration: IdGeneration

  constructor(
    @inject(AppConfig) config: AppConfig,
    @inject(IdGeneration) idGeneration: IdGeneration,
  ) {
    this.idGeneration = idGeneration
    const url = config.redis.url
    const keyPrefix = config.redis.keyPrefix
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
  async onAppStart(): Promise<void> {
    await this.raw.connect()
  }

  /** 应用停止：断开 Redis 连接。 */
  async onAppStop(): Promise<void> {
    await this.close()
  }

  async close(): Promise<void> {
    this.logger.info('正在断开Redis连接')
    await this.raw.quit()
    this.logger.info('Redis连接已断开')
  }
}
