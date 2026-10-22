import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common'
import { AppLogger, Scheduler, type ScheduledJob } from '@repo/kits'
import { RuleRegistry } from './rule.registry.js'

/**
 * 时间槽：按评估周期注册 cron，不按规则注册。
 * 同一个周期只跑一个 job；规则由引擎按周期筛选。
 */
@Injectable()
export class MonitorTimeline implements OnApplicationShutdown {
  private readonly jobs: ScheduledJob[] = []

  constructor(
    @Inject(Scheduler) private readonly scheduler: Scheduler,
    @Inject(RuleRegistry) private readonly rules: RuleRegistry,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  start(run: (intervalSeconds: number) => Promise<void>): void {
    for (const interval of this.rules.intervals()) {
      const expr = cronOf(interval)
      if (!expr) {
        throw new Error(`监控不支持的评估周期：${interval}s（需要能整除 60）`)
      }
      this.jobs.push(
        this.scheduler.scheduleCron(
          `monitor:slot:${interval}`,
          expr,
          () => run(interval),
          { protect: true, timezone: 'Asia/Shanghai' },
        ),
      )
      this.logger.info('已注册监控时间槽', { intervalSeconds: interval, cron: expr })
    }
  }

  onApplicationShutdown(): void {
    for (const job of this.jobs) job.stop()
    this.jobs.length = 0
  }
}

/** 只支持秒级且能整除 60 的周期：60s / 300s */
function cronOf(intervalSeconds: number): string | null {
  if (intervalSeconds === 60) return '* * * * *'
  if (intervalSeconds % 60 !== 0) return null
  const minutes = intervalSeconds / 60
  if (minutes < 1 || minutes > 59) return null
  return `*/${minutes} * * * *`
}
