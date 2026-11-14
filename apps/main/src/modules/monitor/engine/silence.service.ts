import { Inject, Injectable } from '@nestjs/common'
import { RedisStore } from '@repo/kits'

/** 静默键：同一规则同一主体在命中后一段时间内不重复通知 */
@Injectable()
export class SilenceService {
  constructor(@Inject(RedisStore) private readonly redis: RedisStore) {}

  private key(ruleKey: string, subjectId: string): string {
    return `monitor:silence:${ruleKey}:${subjectId}`
  }

  async isSilenced(ruleKey: string, subjectId: string): Promise<boolean> {
    return (await this.redis.get(this.key(ruleKey, subjectId))) !== null
  }

  /** 发送成功后才调用；seconds = 0 表示不静默 */
  async mark(ruleKey: string, subjectId: string, seconds: number): Promise<void> {
    if (seconds <= 0) return
    await this.redis.set(this.key(ruleKey, subjectId), '1', seconds)
  }

  async clear(ruleKey: string, subjectId: string): Promise<void> {
    await this.redis.del(this.key(ruleKey, subjectId))
  }
}
