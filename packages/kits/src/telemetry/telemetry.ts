/** 对数桶直方图的桶上边界（ms / 计数单位）：指数分布，覆盖告警场景量级 */
const BUCKET_EDGES = [
  1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768,
]

/** 已结束窗口最多保留多少个；引擎长时间不取时丢弃最旧的，避免内存无限增长 */
const MAX_COMPLETED_WINDOWS = 10

/** 直方图窗口聚合结果 */
export interface TelemetryHistogram {
  count: number
  sum: number
  /** 分位数（p 为 0..1，如 0.95）；样本为空返回 0 */
  quantile(p: number): number
}

/** 窗口聚合快照：当前窗口 + 前一窗口（surge 环比基线用） */
export interface TelemetrySnapshot {
  windowSeconds: number
  /** 当前窗口开始时间戳 */
  windowStartAt: number
  /** 前一窗口开始时间戳（首个窗口无基线） */
  previousWindowStartAt: number | null
  /** 当前窗口计数（rate = value / windowSeconds） */
  counters: Record<string, number>
  /** 前一窗口计数（surge 环比用） */
  previousCounters: Record<string, number>
  /** 当前值（仪表） */
  gauges: Record<string, number>
  /** 直方图聚合（P50 / P95 / P99 等） */
  histograms: Record<string, TelemetryHistogram>
}

/** 一个已经结束的窗口，供监控采集器按窗口落库 */
export interface TelemetryWindow {
  windowStartAt: number
  windowEndAt: number
  counters: Record<string, number>
  gauges: Record<string, number>
  histograms: Record<string, TelemetryHistogram>
}

/** 单指标窗口内部状态 */
interface MetricState {
  counter: number
  gauge: number
  histCounts: number[]
  histSum: number
}

/**
 * 遥测埋点统一入口（通用，任何业务可埋点）。
 *
 * 能力：Counter（计数）、Gauge（当前值）、Histogram（对数桶直方图 → 近似分位）。
 * 窗口按墙钟对齐（默认 60s）：`incr` / `gauge` / `histogram` 写入当前窗口；
 * `snapshot()` 返回当前窗口 + 前一窗口（surge 环比）；
 * `drainCompleted()` 取走所有已结束窗口，供监控引擎按窗口落库。
 *
 * 存储为进程内内存（单实例；多实例各采各的，样本带 instanceId）。
 *
 * 指标名约定 `<域>.<名称>`（kebab），如 request.duration / order.count / inventory.available。
 */
/**
 * 遥测埋点（Counter / Gauge / Histogram 的窗口聚合）。
 *
 * **不是容器直接装配的 provider**：构造器的 `windowSeconds` 是数值参数（非注入 token），
 * 由 `TelemetryModule` 用 `useFactory: () => new Telemetry()` 装配，故刻意不标
 * `@Injectable()`——DI 装饰器只属于由 Nest 容器解析构造器参数的类。
 */
export class Telemetry {
  private readonly states = new Map<string, MetricState>()
  private readonly windowMs: number
  private windowStartAt: number
  private previousWindowStartAt: number | null = null
  private readonly previousCounters = new Map<string, number>()
  /** 已结束窗口队列（旧 → 新）；超过上限丢最旧的 */
  private readonly completed: TelemetryWindow[] = []

  constructor(
    private readonly windowSeconds = 60,
  ) {
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
      throw new Error(`Telemetry 窗口必须是正数，收到: ${windowSeconds}`)
    }
    this.windowMs = windowSeconds * 1000
    this.windowStartAt = Math.floor(Date.now() / this.windowMs) * this.windowMs
  }

  /** 计数器 +by（默认 1） */
  incr(name: string, by = 1): void {
    this.roll()
    const state = this.stateOf(name)
    state.counter += by
  }

  /** 仪表：设置当前值 */
  gauge(name: string, value: number): void {
    this.roll()
    const state = this.stateOf(name)
    state.gauge = value
  }

  /** 直方图：记录一个样本值（耗时 ms / 计数单位） */
  histogram(name: string, value: number): void {
    this.roll()
    const state = this.stateOf(name)
    state.histSum += value
    const bucketIndex = BUCKET_EDGES.findIndex((edge) => value <= edge)
    state.histCounts[bucketIndex === -1 ? BUCKET_EDGES.length - 1 : bucketIndex] += 1
  }

  /** 当前窗口 + 前一窗口快照（滚动窗口：超 windowSeconds 时当前 → 前一，重置当前） */
  snapshot(): TelemetrySnapshot {
    this.roll()
    const current = this.windowOf(this.windowStartAt, this.windowStartAt + this.windowMs)

    return {
      windowSeconds: this.windowSeconds,
      windowStartAt: this.windowStartAt,
      previousWindowStartAt: this.previousWindowStartAt,
      counters: current.counters,
      previousCounters: Object.fromEntries(this.previousCounters),
      gauges: current.gauges,
      histograms: current.histograms,
    }
  }

  /**
   * 取走所有已结束窗口，按时间从旧到新返回。
   * 窗口按 `floor(now / windowMs) * windowMs` 对齐；调用方负责逐窗口采集。
   */
  drainCompleted(now = Date.now()): TelemetryWindow[] {
    this.roll(now)
    if (this.completed.length === 0) return []
    return this.completed.splice(0, this.completed.length)
  }

  private stateOf(name: string): MetricState {
    let state = this.states.get(name)
    if (!state) {
      state = { counter: 0, gauge: 0, histCounts: new Array(BUCKET_EDGES.length).fill(0), histSum: 0 }
      this.states.set(name, state)
    }
    return state
  }

  /**
   * 按墙钟推进窗口：把 `now` 之前所有已结束窗口切出来，当前窗口从对齐边界重新开始。
   * 一次可能推进多个窗口（进程卡顿 / 长时间没读取），逐个归档，不能只滚一次。
   */
  private roll(now = Date.now()): void {
    while (now >= this.windowStartAt + this.windowMs) {
      const windowEndAt = this.windowStartAt + this.windowMs
      this.completed.push(this.windowOf(this.windowStartAt, windowEndAt))
      if (this.completed.length > MAX_COMPLETED_WINDOWS) {
        this.completed.shift()
      }

      // 保留「前一窗口」语义给 snapshot（surge 用）：取最后一个已结束窗口的计数
      this.previousCounters.clear()
      for (const [name, state] of this.states) {
        this.previousCounters.set(name, state.counter)
        state.counter = 0
        state.histCounts.fill(0)
        state.histSum = 0
      }
      this.previousWindowStartAt = this.windowStartAt
      this.windowStartAt = windowEndAt
    }
  }

  /** 生成指定窗口的聚合快照（不修改状态） */
  private windowOf(windowStartAt: number, windowEndAt: number): TelemetryWindow {
    const counters: Record<string, number> = {}
    const gauges: Record<string, number> = {}
    const histograms: Record<string, TelemetryHistogram> = {}

    for (const [name, state] of this.states) {
      if (state.counter !== 0) counters[name] = state.counter
      gauges[name] = state.gauge
      if (state.histSum !== 0 || state.histCounts.some((count) => count > 0)) {
        histograms[name] = this.histogramOf(state)
      }
    }

    return { windowStartAt, windowEndAt, counters, gauges, histograms }
  }

  private histogramOf(state: MetricState): TelemetryHistogram {
    const counts = [...state.histCounts]
    const sum = state.histSum
    const total = counts.reduce((acc, count) => acc + count, 0)
    return {
      count: total,
      sum,
      quantile(p: number): number {
        if (total === 0) return 0
        const target = Math.min(Math.max(p, 0), 1) * total
        let cumulative = 0
        for (let i = 0; i < counts.length; i++) {
          cumulative += counts[i]
          if (cumulative >= target) {
            return BUCKET_EDGES[i]
          }
        }
        return BUCKET_EDGES[BUCKET_EDGES.length - 1]
      },
    }
  }
}
