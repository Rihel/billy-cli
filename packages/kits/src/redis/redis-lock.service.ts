import { AppLogger } from '../foundation/logger/app-logger.js'
import { sleep } from '@repo/shared'
import { Inject, Injectable } from '@nestjs/common'
import { RedisLockError } from '../foundation/errors/infrastructure-errors.js'
import { IdGeneration } from '../foundation/id-generation/id-generation.js'
import { RedisStore } from './redis-store.js'

/** 解锁：仅当持有者匹配才删除（Lua 保证读-判-删原子） */
const unlockScript = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

/** 续期：仅当持有者匹配才续 TTL（Lua 保证读-判-续原子） */
const renewScript = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('expire', KEYS[1], ARGV[2])
end
return 0
`

/** 自旋等待间隔（毫秒） */
const RETRY_INTERVAL_MS = 100

/**
 * 分布式锁统一入口（Redis SET NX EX + Lua 原子释放/续期 + 看门狗自动续期）。
 *
 * 与 {@link RedisStore.acquireLock} 的区别：这里解决「临界区长于锁 TTL」与「锁被占用时排队」
 * 两个工程问题 —— 看门狗按 TTL/3 自动续期，`lock()` 自旋等待直到拿到锁或超时。
 *
 * 推荐用法（异常也会释放）：
 *
 *   constructor(@Inject(RedisLockService) private readonly lock: RedisLockService) {}
 *   await this.lock.withLock('order:123', 30, 10, () => this.doWork())
 *
 * 注意：看门狗只保证持锁进程存活期间的续期；进程被杀仍需依赖 TTL 兜底（这是设计上的取舍）。
 */
@Injectable()
export class RedisLockService {
  /** 当前持有的锁：锁 key → { 持有者 token, 看门狗定时器 } */
  private readonly lockers = new Map<
    string,
    { value: string; watchDog?: ReturnType<typeof setInterval> }
  >()

  /** Lua 脚本 SHA（惰性加载，避免依赖 RedisStore 的启动时序） */
  private scriptsPromise?: Promise<{ unlock: string; renew: string }>

  constructor(
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(IdGeneration) private readonly idGeneration: IdGeneration,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /**
   * 加锁：自旋等待，直到成功或超过 `timeoutSeconds`。
   * @param key 业务锁 key（建议 `域:标识`，如 `order:123`）
   * @param ttlSeconds 锁 TTL（秒）；持锁期间由看门狗自动续期
   * @param timeoutSeconds 获取锁的最长等待时间（秒），超时抛 RedisLockError
   * @returns 持锁 token（传给 unlock 校验持有者）
   */
  async lock(key: string, ttlSeconds: number, timeoutSeconds: number): Promise<string> {
    const value = this.idGeneration.next(20)
    const maxAttempts = Math.max(1, Math.round((timeoutSeconds * 1000) / RETRY_INTERVAL_MS))

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await this.redis.raw.set(key, value, 'EX', ttlSeconds, 'NX')
      if (result === 'OK') {
        this.lockers.set(key, { value })
        this.startWatchDog(key, value, ttlSeconds)
        return value
      }
      await sleep(RETRY_INTERVAL_MS)
    }

    throw new RedisLockError(key)
  }

  /** 解锁：仅当持有者匹配才删除锁，并停止看门狗；返回是否真的释放成功 */
  async unlock(key: string, value: string): Promise<boolean> {
    const { unlock } = await this.ensureScripts()
    try {
      const result = (await this.redis.raw.evalsha(unlock, 1, key, value)) as number
      if (result !== 1) {
        this.logger.warn('Redis 解锁失败：锁已过期或已被他人持有', { key })
      }
      return result === 1
    } finally {
      this.stopWatchDog(key)
      this.lockers.delete(key)
    }
  }

  /**
   * 自动加解锁（推荐入口）：拿到锁后执行业务，无论成功失败都释放。
   */
  async withLock<Result>(
    key: string,
    ttlSeconds: number,
    timeoutSeconds: number,
    handler: () => Promise<Result> | Result,
  ): Promise<Result> {
    const value = await this.lock(key, ttlSeconds, timeoutSeconds)
    try {
      return await handler()
    } finally {
      await this.unlock(key, value)
    }
  }

  /** 当前进程持有的锁数量（可观测用） */
  get heldCount(): number {
    return this.lockers.size
  }

  private ensureScripts(): Promise<{ unlock: string; renew: string }> {
    return (this.scriptsPromise ??= (async () => ({
      unlock: (await this.redis.raw.script('LOAD', unlockScript)) as string,
      renew: (await this.redis.raw.script('LOAD', renewScript)) as string,
    }))())
  }

  /** 看门狗：按 TTL/3 周期续期；续期失败即认为已丢锁并停止 */
  private startWatchDog(key: string, value: string, ttlSeconds: number): void {
    const interval = Math.max(1, Math.round((ttlSeconds * 1000) / 3))
    const watchDog = setInterval(() => {
      void (async () => {
        try {
          const { renew } = await this.ensureScripts()
          const result = (await this.redis.raw.evalsha(renew, 1, key, value, ttlSeconds)) as number
          if (result !== 1) {
            this.logger.warn('Redis 续锁失败：锁已丢失', { key })
            this.stopWatchDog(key)
          }
        } catch (error) {
          this.logger.error('Redis 续锁异常', { key, error })
          this.stopWatchDog(key)
        }
      })()
    }, interval)
    const locker = this.lockers.get(key)
    if (locker) locker.watchDog = watchDog
  }

  private stopWatchDog(key: string): void {
    const locker = this.lockers.get(key)
    if (locker?.watchDog) {
      clearInterval(locker.watchDog)
      locker.watchDog = undefined
    }
  }
}
