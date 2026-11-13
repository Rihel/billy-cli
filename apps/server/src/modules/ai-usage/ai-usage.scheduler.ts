import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { AppLogger, RedisStore, Scheduler } from '@repo/kits'
import { AiUsageService } from './ai-usage.service.js'

/** AI 用量汇总：每 10 分钟重算今天 + 昨天，Redis 锁保证多实例只跑一个 */
@Injectable()
export class AiUsageScheduler implements OnApplicationBootstrap {
  constructor(
    @Inject(Scheduler) private readonly scheduler: Scheduler,
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(AiUsageService) private readonly usage: AiUsageService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.scheduler.scheduleCron('ai-usage-rollup', '*/10 * * * *', () => this.run(), {
      protect: true,
      timezone: 'Asia/Shanghai',
    })
    // 首次启动补一次，避免控制台等 10 分钟
    await this.run()
  }

  private async run(): Promise<void> {
    const token = await this.redis.acquireLock('ai-usage-rollup', 600)
    if (!token) return
    try {
      const [today, yesterday] = this.usage.recentDates()
      await this.usage.backfill(yesterday, today)
    } catch (error) {
      this.logger.error('ai.usage.rollup_failed', { error })
    } finally {
      await this.redis.releaseLock('ai-usage-rollup', token)
    }
  }
}
