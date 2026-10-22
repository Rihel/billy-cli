/** 一个统计窗口：半开区间 [start, end)，key 用于样本唯一键 */
export interface MetricWindow {
  key: string
  start: Date
  end: Date
}

/** 指标文件返回的点：窗口、实例由引擎补，指标文件不自己编 key */
export interface MetricPoint {
  value: number
  dimensionType?: string
  dimensionKey?: string
  labels?: Record<string, string>
}

/** 落库样本（与 monitor_metric_samples 对应） */
export interface MetricSample {
  metricKey: string
  metricKind: 'raw' | 'derived'
  windowKey: string
  windowStart: Date
  windowEnd: Date
  instanceId: string
  dimensionType: string
  dimensionKey: string
  value: number
  labels?: Record<string, string>
}

export interface SourceContext {
  now: Date
  window: MetricWindow
  instanceId: string
}

/** 指标源：参数无关，一个 tick 内只读一次；失败用异常表达 */
export interface MetricSource<T = unknown> {
  key: string
  read(ctx: SourceContext): Promise<T>
}

interface MetricDefinitionBase {
  key: string
  title: string
  description: string
  category: 'system' | 'business'
  unit: 'ratio' | 'ms' | 'count' | 'tokens' | 'bytes'
  evaluationIntervalSeconds: number
  windowSeconds: number
  /** 最新样本超过这个时长没更新就视为陈旧 */
  staleAfterSeconds: number
  scope: 'instance' | 'global'
}

export interface RawMetricDefinition extends MetricDefinitionBase {
  kind: 'raw'
  /** 只声明依赖哪个源；源自己负责读取 */
  source: string
  collect(ctx: CollectContext): MetricPoint[] | Promise<MetricPoint[]>
}

export interface DerivedMetricDefinition extends MetricDefinitionBase {
  kind: 'derived'
  /** 第一版只允许依赖 raw，避免多级派生和循环 */
  dependsOn: readonly string[]
  derive(ctx: DeriveContext): MetricPoint[] | Promise<MetricPoint[]>
}

export type MetricDefinition = RawMetricDefinition | DerivedMetricDefinition

export interface CollectContext {
  window: MetricWindow
  instanceId: string
  /** 指标源读到的数据，结构由 source 决定 */
  data: unknown
  cache: Map<string, unknown>
}

export interface DeriveContext {
  window: MetricWindow
  instanceId: string
  dimensionType: string
  dimensionKey: string
  /** 同窗口、同维度的原始值；缺失返回 undefined，衍生指标应跳过而不是当 0 */
  raw(metricKey: string): number | undefined
}
