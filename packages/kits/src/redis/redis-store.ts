import { AppLogger } from '../foundation/logger/app-logger.js'
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
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

  /** 探活（readiness 用） */
  ping(): Promise<string> {
    return this.fromPromise(() => this.raw.ping())
  }

  /** 发布消息（StreamHub / 跨副本事件） */
  publish(channel: string, message: string): Promise<number> {
    return this.fromPromise(() => this.raw.publish(channel, message))
  }

  /**
   * 订阅一批频道；返回取消订阅函数（内部使用独立连接并 quit）。
   *
   * 业务代码不应自己 `duplicate()`：订阅连接的生命周期由这里统一收口。
   */
  async subscribe(
    channels: readonly string[],
    onMessage: (channel: string, message: string) => void,
  ): Promise<() => Promise<void>> {
    const subscriber = this.raw.duplicate()
    subscriber.on('message', (channel: string, message: string) => onMessage(channel, message))
    await this.fromPromise(() => subscriber.subscribe(...channels))
    return async () => {
      try {
        await subscriber.unsubscribe(...channels)
      } finally {
        await subscriber.quit()
      }
    }
  }

  // ── List（流式输出缓冲） ─────────────────────────────────────

  rpush(key: string, value: string): Promise<number> {
    return this.fromPromise(() => this.raw.rpush(key, value))
  }

  ltrim(key: string, start: number, stop: number): Promise<string> {
    return this.fromPromise(() => this.raw.ltrim(key, start, stop))
  }

  lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.fromPromise(() => this.raw.lrange(key, start, stop))
  }

  // ── Hash（运行进度 / 规则状态 / 注册表） ─────────────────────

  hset(key: string, fields: Record<string, string | number>): Promise<number> {
    return this.fromPromise(() => this.raw.hset(key, fields))
  }

  hgetall(key: string): Promise<Record<string, string>> {
    return this.fromPromise(() => this.raw.hgetall(key))
  }

  /**
   * 原子替换一个 Hash 的内容（可选 TTL）。
   *
   * 规则状态是「整份快照」语义：先删再写，不能把上一轮已消失的字段留下来。
   */
  async replaceHash(
    key: string,
    fields: Record<string, string>,
    ttlSeconds?: number,
  ): Promise<void> {
    await this.fromPromise(async () => {
      const pipeline = this.raw.pipeline()
      pipeline.del(key)
      if (Object.keys(fields).length > 0) pipeline.hset(key, fields)
      if (ttlSeconds !== undefined) pipeline.expire(key, ttlSeconds)
      await pipeline.exec()
    })
  }

  // ── ZSet（worker 注册表按心跳时间排序） ───────────────────────

  zadd(key: string, score: number, member: string): Promise<number> {
    return this.fromPromise(() => this.raw.zadd(key, score, member))
  }

  zrem(key: string, member: string): Promise<number> {
    return this.fromPromise(() => this.raw.zrem(key, member))
  }

  zrangeByScore(
    key: string,
    min: number | string,
    max: number | string,
    options: { offset?: number; count?: number } = {},
  ): Promise<string[]> {
    const offset = options.offset ?? 0
    const count = options.count ?? 50
    return this.fromPromise(() => this.raw.zrangebyscore(key, min, max, 'LIMIT', offset, count))
  }

  pexpire(key: string, milliseconds: number): Promise<boolean> {
    return this.fromPromise(() => this.raw.pexpire(key, milliseconds).then(Boolean))
  }

  /** 按 pattern 扫键（SCAN 分批，不用 KEYS）；返回全部命中键 */
  async scanKeys(pattern: string, count = 200): Promise<string[]> {
    const keys: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = await this.fromPromise(() =>
        this.raw.scan(cursor, 'MATCH', pattern, 'COUNT', count),
      )
      cursor = next
      keys.push(...batch)
    } while (cursor !== '0')
    return keys
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
