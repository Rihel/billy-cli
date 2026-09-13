import { Global, Module } from '@nestjs/common'
import { RateLimiter } from './rate-limiter.js'

/**
 * 限流模块：无自有配置，复用 RedisModule 提供的 RedisConfig（计数落在 Redis）。
 * 装配顺序上需排在 RedisModule 之后（后者提供 RedisConfig）。
 */
@Global()
@Module({ providers: [RateLimiter], exports: [RateLimiter] })
export class RateLimitModule {}
