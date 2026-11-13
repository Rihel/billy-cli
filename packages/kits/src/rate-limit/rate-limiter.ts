import { Inject, Injectable } from '@nestjs/common'
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible'
import { RedisStore } from '../redis/redis-store.js'

/** 限流判定结果。 */
export interface RateLimitDecision {
  /** 是否放行 */
  allowed: boolean
  /** 本窗口剩余配额（超限为 0） */
  remaining: number
  /** 超限时建议重试秒数（未超限为 0） */
  retryAfterSeconds: number
}

/**
 * 限流统一入口（基于 rate-limiter-flexible 的 RateLimiterRedis，Redis 存储）。
 *
 * - 默认固定窗口（points / duration），底层 Lua 脚本原子计数；
 * - 底层实例按 `(limit, windowSeconds)` 组合缓存复用（不同 scope 可配不同阈值）；
 * - `consume` 超限抛 `RateLimiterResError`（带 msBeforeNext），映射为
 *   `{ allowed: false, retryAfterSeconds }`；非限流错误（如 Redis 故障）原样上抛。
 *
 * key 约定：调用方传 `scope:标识`（如 `login:1.2.3.4`），统一入口统一加 `ratelimit:` 前缀。
 * 需要更精确的算法（滑动窗口 / 令牌桶）时，改用 RateLimiterSlidingWindow / RateLimiterTokenBucket。
 */
@Injectable()
export class RateLimiter {
  private readonly limiters = new Map<string, RateLimiterRedis>()

  constructor(@Inject(RedisStore) private readonly redis: RedisStore) {}

  private limiterFor(limit: number, windowSeconds: number): RateLimiterRedis {
    const cacheKey = `${limit}:${windowSeconds}`
    let limiter = this.limiters.get(cacheKey)
    if (!limiter) {
      limiter = new RateLimiterRedis({
        storeClient: this.redis.raw,
        keyPrefix: 'ratelimit',
        points: limit,
        duration: windowSeconds,
      })
      this.limiters.set(cacheKey, limiter)
    }
    return limiter
  }

  /** 计数并判定：命中返回配额信息，超限返回 retryAfterSeconds。 */
  async check(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
    try {
      const result = await this.limiterFor(limit, windowSeconds).consume(key)
      return {
        allowed: true,
        remaining: Math.max(result.remainingPoints, 0),
        retryAfterSeconds: 0,
      }
    } catch (error) {
      // rate-limiter-flexible 11.x：超限时 consume reject 的是 RateLimiterRes 实例
      // （非 Error），以 consumedPoints > limit 判定；其余（Redis 故障等）原样上抛
      if (error instanceof RateLimiterRes && error.consumedPoints > limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(Math.ceil(error.msBeforeNext / 1000), 1),
        }
      }
      throw error
    }
  }
}
