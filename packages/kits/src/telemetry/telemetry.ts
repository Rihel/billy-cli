/** 对数桶直方图的桶上边界（ms / 计数单位）：指数分布，覆盖告警场景量级 */
const BUCKET_EDGES = [
  1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768,
]

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
 * 窗口聚合：固定窗口（默认 60s），snapshot() 返回当前窗口 + 前一窗口（surge 环比）。
 * 存储为进程内内存（单实例；多实例后续接 Redis 聚合）。
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
  private windowStartAt = Date.now()
  private previousWindowStartAt: number | null = null
  private readonly previousCounters = new Map<string, number>()

  constructor(
    private readonly windowSeconds = 60,
  ) {}

  /** 计数器 +by（默认 1） */
  incr(name: string, by = 1): void {
    const state = this.stateOf(name)
    state.counter += by
  }

  /** 仪表：设置当前值 */
  gauge(name: string, value: number): void {
    const state = this.stateOf(name)
    state.gauge = value
  }

  /** 直方图：记录一个样本值（耗时 ms / 计数单位） */
  histogram(name: string, value: number): void {
    const state = this.stateOf(name)
    state.histSum += value
    const bucketIndex = BUCKET_EDGES.findIndex((edge) => value <= edge)
    state.histCounts[bucketIndex === -1 ? BUCKET_EDGES.length - 1 : bucketIndex] += 1
  }

  /** 窗口聚合快照（滚动窗口：超 windowSeconds 时当前 → 前一，重置当前） */
  snapshot(): TelemetrySnapshot {
    this.rollWindowIfNeeded()

    const counters: Record<string, number> = {}
    const gauges: Record<string, number> = {}
    const histograms: Record<string, TelemetryHistogram> = {}
    const previousCounters: Record<string, number> = Object.fromEntries(
      this.previousCounters,
    )

    for (const [name, state] of this.states) {
      if (state.counter !== 0) counters[name] = state.counter
      gauges[name] = state.gauge
      if (state.histSum !== 0 || state.histCounts.some((count) => count > 0)) {
        histograms[name] = this.histogramOf(name, state)
      }
    }

    return {
      windowSeconds: this.windowSeconds,
      windowStartAt: this.windowStartAt,
      previousWindowStartAt: this.previousWindowStartAt,
      counters,
      previousCounters,
      gauges,
      histograms,
    }
  }

  private stateOf(name: string): MetricState {
    // 写入前滚动窗口（超时归档为前一窗口基线，当前重置），保证计数落在正确的窗口
    this.rollWindowIfNeeded()
    let state = this.states.get(name)
    if (!state) {
      state = { counter: 0, gauge: 0, histCounts: new Array(BUCKET_EDGES.length).fill(0), histSum: 0 }
      this.states.set(name, state)
    }
    return state
  }

  /** 窗口滚动：当前计数归档为前一窗口（surge 基线），当前窗口重置 */
  private rollWindowIfNeeded(): void {
    const now = Date.now()
    if (now - this.windowStartAt < this.windowSeconds * 1000) return
    this.previousCounters.clear()
    for (const [name, state] of this.states) {
      this.previousCounters.set(name, state.counter)
      state.counter = 0
      state.histCounts.fill(0)
      state.histSum = 0
    }
    this.previousWindowStartAt = this.windowStartAt
    this.windowStartAt = now
  }

  private histogramOf(_name: string, state: MetricState): TelemetryHistogram {
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
