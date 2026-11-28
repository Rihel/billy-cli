import { Inject, Injectable } from '@nestjs/common'
import { RedisStore } from '@repo/kits'
import type { ToolRateCounter } from './tool.ports.js'

/** 生产实现：Redis 的 `INCR` + 首次设置过期（多实例安全） */
@Injectable()
export class RedisToolRateCounter implements ToolRateCounter {
  constructor(@Inject(RedisStore) private readonly redis: RedisStore) {}

  async incr(key: string, windowSeconds: number): Promise<number> {
    const count = await this.redis.incr(key)
    if (count === 1) await this.redis.expire(key, windowSeconds)
    return count
  }
}
