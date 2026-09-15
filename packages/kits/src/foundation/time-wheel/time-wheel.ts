import { Cron } from 'croner'
import { maybePromise, nanoid } from '@repo/shared'

/** 时间轮任务类型 */
export const TimeWheelType = {
  /** 固定间隔周期触发 */
  Interval: 'interval',
  /** 单次延迟触发 */
  Once: 'once',
  /** cron 表达式周期触发 */
  Cron: 'cron',
} as const

export type TimeWheelTypeValue =
  (typeof TimeWheelType)[keyof typeof TimeWheelType]

/** 登记到时间轮上的任务定义 */
export type TimeWheelJob = {
  id: string
  type: TimeWheelTypeValue
  exec: (task: TimeWheelTask, job: TimeWheelJob) => void | Promise<void>
  /** 任务执行抛错时的回调（不传则静默吞掉，保证 tick 循环不中断） */
  onError?: (error: unknown, task: TimeWheelTask, job: TimeWheelJob) => void

  data?: unknown
  createdTime?: number
  /** type = once 时的延迟毫秒数 */
  timeout?: number
  /** type = interval 时的间隔毫秒数 */
  interval?: number
  /** type = cron 时的表达式（支持秒级字段） */
  cron?: string
}

/** 任务在某个槽位里的一次具体排期 */
export type TimeWheelTask = {
  id: string
  jobId: string
  createdTime: number
  planNextTime: number
  actualNextTime?: number
  /** 实际触发时间与计划时间的偏差（毫秒），用于观测调度精度 */
  offset?: number
  exec: (task: TimeWheelTask, job: TimeWheelJob) => void | Promise<void>
  remainingWheels: number
}

export type Wheels = Array<TimeWheelTask[]>

const nextTick =
  typeof setImmediate === 'function'
    ? setImmediate
    : (fn: () => void) => setTimeout(fn, 0)

/** 调度时间基准：优先单调时钟，避免系统时间调整造成漂移 */
const nowTime = () =>
  typeof performance !== 'undefined' ? Math.floor(performance.now()) : Date.now()

/**
 * 时间轮（进程内高频调度原语）。
 *
 * 适用「大量任务 + 毫秒/秒级精度」的场景（限流窗口、批量节流、心跳轮），
 * O(1) 槽位插入，避免为每个任务各挂一个 `setTimeout`。
 *
 * 与 `foundation/scheduler` 的 `Scheduler`（croner，平台级定时任务门面）职责不同：
 * 前者管「每天 3 点跑对账」，本类管「每 N 毫秒 tick 一次」。
 *
 * 关键设计：
 * - **自适应补偿**：每次 tick 后按 `nextTickTime += tickDuration` 推进理论时间，
 *   再按差值设置下一次定时器，消除回调执行耗时累积的漂移；
 * - **落后任务防堆积**：间隔任务若目标时间已明显落后于当前时间，按一个刻度往后补偿，
 *   避免卡顿后瞬间补跑一堆任务；
 * - 任务异常交给 `onError` 处理并吞掉，不打断 tick 循环。
 *
 * 归位：横切基础能力 → `packages/kits/src/foundation/time-wheel/`（`placement.md` §7 调度器）。
 *
 * **为什么不做成 `XxxModule` 单例**：本类需要构造参数（刻度时长 / 刻度数），
 * 不同场景精度不同 → 天然多实例；且无外部资源连接，不需要 Nest 托管生命周期。
 * 故只导出类，由使用方 `new TimeWheel(tickDuration, wheelsCount)` 并自行 `start()` / `stop()`。
 */
export class TimeWheel {
  private jobs: Record<string, TimeWheelJob> = {}

  private currentTick = 0
  private wheels: Wheels = []
  private interval: ReturnType<typeof setTimeout> | null = null
  private jobLastScheduleTime: Record<string, number> = {}
  private nextJobTaskSlotIndex: Record<string, number> = {}
  private nextTickTime = 0

  /**
   * @param tickDuration 单格刻度时长（毫秒），也是最小调度精度
   * @param wheelsCount 刻度格数量，决定一轮能覆盖的时间跨度 = tickDuration * wheelsCount
   */
  constructor(
    private readonly tickDuration: number,
    private readonly wheelsCount: number,
  ) {
    if (tickDuration <= 0) throw new Error('tickDuration must be > 0')
    if (wheelsCount <= 0) throw new Error('wheelsCount must be > 0')
    this.reset()
  }

  get isRunning(): boolean {
    return !!this.interval
  }

  /** 清空全部任务与排期，并停止运行。 */
  reset(): void {
    this.jobs = {}
    this.currentTick = 0
    this.wheels = new Array(this.wheelsCount).fill(null).map(() => [])
    this.jobLastScheduleTime = {}
    this.nextJobTaskSlotIndex = {}
    this.nextTickTime = 0
    this.stop()
  }

  private tick(): void {
    const currentSlotTasks = this.wheels[this.currentTick]

    const executionTasks: TimeWheelTask[] = []
    const remainingTasks: TimeWheelTask[] = []
    for (const task of currentSlotTasks) {
      if (task.remainingWheels <= 0) {
        executionTasks.push(task)
      } else {
        task.remainingWheels -= 1
        remainingTasks.push(task)
      }
    }

    for (const task of executionTasks) {
      const job = this.jobs[task.jobId]
      if (!job) continue
      // 交给下一个事件循环执行，避免同步阻塞本格其余任务
      nextTick(() => {
        // 派发到下一个事件循环期间可能已 stop()：此时必须放弃执行，
        // 否则「停表后还会蹦出一次任务」，且让行为不可预期（单测因此偶发失败）。
        if (!this.isRunning) return
        task.actualNextTime = nowTime()
        task.offset = task.actualNextTime - task.planNextTime
        // 必须同时兜住「同步抛错」与「异步 reject」：
        // exec 同步抛错时 maybePromise 根本没机会接手，异常会冒泡成未捕获异常。
        try {
          maybePromise(task.exec(task, job)).catch((error) => {
            this.failJob(error, task, job)
          })
        } catch (error) {
          this.failJob(error, task, job)
        }
      })
      if (job.type === TimeWheelType.Once) {
        this.removeJob(job.id)
      } else {
        // 非单次任务：立即排下一轮
        this.scheduleTask(job)
      }
    }

    this.wheels[this.currentTick] = remainingTasks
    this.currentTick = (this.currentTick + 1) % this.wheelsCount
  }

  /** 启动 tick 循环（幂等）。 */
  start(): void {
    if (this.isRunning) return

    this.nextTickTime = nowTime()
    const loop = () => {
      this.tick()
      // 自适应补偿：按理论时间推进，消除 tick 自身的执行损耗
      this.nextTickTime += this.tickDuration
      const delay = Math.max(0, this.nextTickTime - nowTime())
      this.interval = setTimeout(loop, delay)
    }
    this.interval = setTimeout(loop, this.tickDuration)
  }

  /** 停止 tick 循环（幂等，不清任务）。 */
  stop(): void {
    if (this.interval) {
      clearTimeout(this.interval)
      this.interval = null
    }
  }

  /** 任务失败出口：把异常交给 onError，并保证它绝不冒泡（否则会中断 tick 循环） */
  private failJob(
    error: unknown,
    task: TimeWheelTask,
    job: TimeWheelJob,
  ): void {
    try {
      job.onError?.(error, task, job)
    } catch {
      // onError 自身抛错也必须吞掉：本类承诺「任务异常不打断调度」，
      // 若让它冒泡就退化成未捕获异常，会拖垮整个进程。
    }
  }

  private nextCronTime(cronExpr: string, baseTime: number): number {
    // paused: true → 只做表达式推算，不真的注册调度
    const job = new Cron(cronExpr, { paused: true })
    const next = job.nextRun(new Date(baseTime))
    if (!next) throw new Error(`cron 表达式无法推算下次执行时间: ${cronExpr}`)
    return next.getTime()
  }

  private scheduleTask(job: TimeWheelJob): void {
    const now = nowTime()
    const jobTime = this.jobLastScheduleTime[job.id]
    let targetTime = 0

    switch (job.type) {
      case TimeWheelType.Interval: {
        // 首次基于当前时间，后续基于上一次的「理论目标时间」，防止漂移累积
        const start = jobTime || now
        targetTime = start + (job.interval || 0)
        // 落后过多（比如进程卡顿）时按一个刻度补偿，防止任务瞬间堆积
        if (targetTime < now) {
          targetTime += this.tickDuration
        }
        break
      }
      case TimeWheelType.Once: {
        targetTime = (jobTime || now) + (job.timeout ?? 0)
        break
      }
      case TimeWheelType.Cron: {
        targetTime = this.nextCronTime(job.cron!, jobTime || now)
        break
      }
    }

    this.jobLastScheduleTime[job.id] = targetTime
    const delay = targetTime - now

    // 至少偏移 1 格：本轮 tick 可能正在扫描当前槽位，插进去会被漏掉
    const tickCount = Math.max(Math.ceil(delay / this.tickDuration), 0)
    const slotIndex = (this.currentTick + tickCount) % this.wheelsCount
    const rounds = Math.floor(tickCount / this.wheelsCount)

    this.wheels[slotIndex].push({
      id: `${job.id}-${nanoid()}`,
      jobId: job.id,
      createdTime: now,
      planNextTime: targetTime,
      remainingWheels: rounds,
      exec: job.exec,
    })
    this.nextJobTaskSlotIndex[job.id] = slotIndex
  }

  /** 移除任务：同时清掉其排期与时间基准。 */
  removeJob(jobId: string): void {
    delete this.jobs[jobId]
    delete this.jobLastScheduleTime[jobId]
    const slotIndex = this.nextJobTaskSlotIndex[jobId]
    if (slotIndex !== undefined) {
      this.wheels[slotIndex] = this.wheels[slotIndex].filter(
        (task) => task.jobId !== jobId,
      )
    }
    delete this.nextJobTaskSlotIndex[jobId]
  }

  /** 登记任务（立即排期）。重复 id 抛错；interval 小于刻度时长抛错。 */
  addJob(job: TimeWheelJob): void {
    if (this.jobs[job.id]) {
      throw new Error(`job ${job.id} already exists`)
    }
    if (
      job.type === TimeWheelType.Interval &&
      (job.interval ?? 0) < this.tickDuration
    ) {
      throw new Error(
        `job ${job.id} interval must be >= tickDuration ${this.tickDuration}ms`,
      )
    }
    if (job.type === TimeWheelType.Cron && !job.cron) {
      throw new Error(`job ${job.id} requires cron expression`)
    }

    this.jobs[job.id] = {
      ...job,
      createdTime: Date.now(),
    }
    this.scheduleTask(this.jobs[job.id])
  }
}
