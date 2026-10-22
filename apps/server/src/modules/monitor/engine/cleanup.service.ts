import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, RedisStore } from '@repo/kits'
import { MonitorConfig, type MonitorConfig as MonitorConfigType } from '../config.js'
import { MetricSampleRepository } from './metric-sample.repository.js'

/** 样本保留期清理：只由 leader 每 10 分钟跑一次 */
@Injectable()
export class CleanupService {
  private lastAt = 0

  constructor(
    @Inject(MetricSampleRepository) private readonly samples: MetricSampleRepository,
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(MonitorConfig) private readonly config: MonitorConfigType,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async maybeCleanup(now: Date): Promise<void> {
    if (now.getTime() - this.lastAt < 10 * 60 * 1000) return
    const token = await this.redis.acquireLock('monitor:cleanup', 600)
    if (!token) return
    try {
      const cutoff = new Date(now.getTime() - this.config.retentionDays * 24 * 60 * 60 * 1000)
      const deleted = await this.samples.deleteOlderThan(cutoff)
      this.lastAt = now.getTime()
      if (deleted > 0) this.logger.log('monitor.samples.cleaned', { deleted })
    } finally {
      await this.redis.releaseLock('monitor:cleanup', token)
    }
  }
}
