import { Cron, type CronOptions } from 'croner'
import { injectable } from 'inversify'
import type { AppLogger } from '@repo/shared/logger'
import type { OnAppStop } from '../composition/life-cycle.js'
import { SchedulerError } from './errors/infrastructure-errors.js'
import { Logger } from './logger.js'

/** 调度任务处理器：可返回 Promise（异步执行），异常由调度器记录并吞掉，不中断调度循环。 */
export type SchedulerHandler = () => Promise<void> | void

/** 已登记调度任务的句柄，供业务侧停止或查询下一次运行时间。 */
export interface ScheduledJob {
  readonly name: string
  /** 停止该任务：cron 永久停止、interval/timeout 清除对应定时器。 */
  stop(): void
  /** 下一次计划运行时间（仅 cron 返回 Date；interval/timeout 返回 null）。 */
  nextRun?(): Date | null
}

/** cron 可透传的选项子集：时区、初始暂停、防重入、错误回调、pattern 模式。 */
export type SchedulerCronOptions = Pick<
  CronOptions,
  'timezone' | 'paused' | 'protect' | 'catch' | 'mode'
>

interface JobRegistration {
  name: string
  stop: () => void
  nextRun?: () => Date | null
}

type TimerHandle = ReturnType<typeof setTimeout>

/**
 * 调度基础设施（定时器 + Cron）门面。
 *
 * - `scheduleCron`：按 cron 表达式周期触发（基于 croner，支持秒级/时区/漏跑恢复）。
 * - `scheduleInterval`：固定间隔周期触发（基于 setInterval）。
 * - `scheduleTimeout`：单次延迟触发（基于 setTimeout），触发后自动清理。
 * - 任务名在 {@link Scheduler} 内唯一，重复注册抛 {@link SchedulerError}。
 * - 处理器异常由调度器统一记日志并吞掉，避免单次失败打断整个调度循环。
 * - 应用停止（`onAppStop`）时统一清理全部任务，幂等。
 *
 * 归位：横切基础能力 → `core/foundation`（`placement.md` §7 将「调度器」归为横切能力）。
 */
@injectable()
export class Scheduler implements OnAppStop {
  @Logger()
  private readonly logger!: AppLogger

  private readonly jobs = new Map<string, JobRegistration>()

  /** 注册一个 cron 周期任务。 */
  scheduleCron(
    name: string,
    cronExpr: string,
    handler: SchedulerHandler,
    options: SchedulerCronOptions = {},
  ): ScheduledJob {
    this.assertUnique(name)
    const job = new Cron(
      cronExpr,
      { name, ...options, catch: true },
      () => void this.runGuarded(name, handler),
    )
    this.jobs.set(name, {
      name,
      stop: () => job.stop(),
      nextRun: () => job.nextRun(),
    })
    this.logger.info('已注册 cron 定时任务', { name, cronExpr, timezone: options.timezone })
    return this.publicHandle(name)
  }

  /** 注册一个固定间隔周期任务（基于 setInterval）。 */
  scheduleInterval(name: string, ms: number, handler: SchedulerHandler): ScheduledJob {
    this.assertUnique(name)
    if (!Number.isFinite(ms) || ms < 0) {
      throw new SchedulerError(new Error(`非法的间隔时长: ${ms}`))
    }
    const timer = setInterval(() => void this.runGuarded(name, handler), ms)
    this.jobs.set(name, { name, stop: () => clearInterval(timer) })
    this.logger.info('已注册定时任务', { name, type: 'interval', intervalMs: ms })
    return this.publicHandle(name)
  }

  /** 注册一个单次延迟任务（基于 setTimeout），触发后自动清理。 */
  scheduleTimeout(name: string, ms: number, handler: SchedulerHandler): ScheduledJob {
    this.assertUnique(name)
    if (!Number.isFinite(ms) || ms < 0) {
      throw new SchedulerError(new Error(`非法的延迟时长: ${ms}`))
    }
    const timer: TimerHandle = setTimeout(() => {
      this.jobs.delete(name)
      void this.runGuarded(name, handler)
    }, ms)
    this.jobs.set(name, { name, stop: () => clearTimeout(timer) })
    this.logger.info('已注册定时任务', { name, type: 'timeout', delayMs: ms })
    return this.publicHandle(name)
  }

  /** 停止指定名称的任务（幂等）。 */
  stop(name: string): void {
    this.jobs.get(name)?.stop()
    this.jobs.delete(name)
  }

  /** 停止并清空全部任务（应用停止时调用，幂等）。 */
  stopAll(): void {
    for (const [name, job] of this.jobs) {
      job.stop()
      this.logger.info('已停止定时任务', { name })
    }
    this.jobs.clear()
  }

  /** 应用优雅停止：统一清理全部调度任务。 */
  async onAppStop(): Promise<void> {
    this.stopAll()
  }

  private assertUnique(name: string): void {
    if (this.jobs.has(name)) {
      throw new SchedulerError(new Error(`定时任务已存在: ${name}`))
    }
  }

  private publicHandle(name: string): ScheduledJob {
    const registration = this.jobs.get(name)
    if (!registration) throw new SchedulerError(new Error(`定时任务不存在: ${name}`))
    return {
      name: registration.name,
      stop: () => this.stop(name),
      ...(registration.nextRun ? { nextRun: registration.nextRun } : {}),
    }
  }

  /** 统一兜底执行：异常记日志并吞掉，保证调度循环不中断。 */
  private async runGuarded(name: string, handler: SchedulerHandler): Promise<void> {
    try {
      await handler()
    } catch (error) {
      this.logger.error('定时任务执行异常', { name, error })
    }
  }
}
