import { Inject, Injectable } from '@nestjs/common'
import { RedisStore } from '@repo/kits'
import type { RuleState } from '../definitions/rule.types.js'

/** stream 规则的跨 tick 状态：Redis 按规则一个 hash（field = subjectId） */
@Injectable()
export class StreamStateService {
  constructor(@Inject(RedisStore) private readonly redis: RedisStore) {}

  private key(ruleKey: string): string {
    return `monitor:stream:${ruleKey}`
  }

  async get(ruleKey: string): Promise<RuleState> {
    const raw = await this.redis.raw.hgetall(this.key(ruleKey))
    const state: RuleState = new Map()
    for (const [subjectId, json] of Object.entries(raw)) {
      try {
        state.set(subjectId, JSON.parse(json) as unknown)
      } catch {
        // 坏值直接丢，下一轮会重建
      }
    }
    return state
  }

  async set(ruleKey: string, state: RuleState, ttlSeconds: number): Promise<void> {
    const key = this.key(ruleKey)
    const pipeline = this.redis.raw.pipeline()
    pipeline.del(key)
    for (const [subjectId, value] of state) {
      pipeline.hset(key, subjectId, JSON.stringify(value))
    }
    if (ttlSeconds > 0) pipeline.expire(key, ttlSeconds)
    await pipeline.exec()
  }

  async clear(ruleKey: string): Promise<void> {
    await this.redis.raw.del(this.key(ruleKey))
  }
}
