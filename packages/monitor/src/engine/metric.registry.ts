import { Inject, Injectable } from '@nestjs/common'
import { SYSTEM_METRICS } from '../metrics/index.js'
import { ProcessSource } from '../sources/process.source.js'
import { TelemetrySource } from '../sources/telemetry.source.js'
import type {
  DerivedMetricDefinition,
  MetricDefinition,
  MetricSource,
  RawMetricDefinition,
} from '../definitions/metric.types.js'

/**
 * 指标注册表：负责登记、校验、按周期查询。
 * 启动时校验失败直接抛错，不让坏定义进运行期。
 */
@Injectable()
export class MetricRegistry {
  private readonly metrics = new Map<string, MetricDefinition>()
  private readonly sources = new Map<string, MetricSource>()

  constructor(
    @Inject(TelemetrySource) private readonly telemetrySource: TelemetrySource,
    @Inject(ProcessSource) private readonly processSource: ProcessSource,
  ) {
    this.sources.set(this.telemetrySource.key, this.telemetrySource)
    this.sources.set(this.processSource.key, this.processSource)
    this.registerMetrics(SYSTEM_METRICS)
  }

  /** 业务模块注册指标（重复 key 启动失败） */
  registerMetrics(definitions: readonly MetricDefinition[]): void {
    for (const definition of definitions) {
      if (this.metrics.has(definition.key)) {
        throw new Error(`指标 key 重复：${definition.key}`)
      }
      this.metrics.set(definition.key, definition)
    }
  }

  /** 业务模块注册自己的数据源（例如 AI 日表） */
  registerSource(source: MetricSource): void {
    if (this.sources.has(source.key)) {
      throw new Error(`指标源 key 重复：${source.key}`)
    }
    this.sources.set(source.key, source)
  }

  get(key: string): MetricDefinition | undefined {
    return this.metrics.get(key)
  }

  all(): MetricDefinition[] {
    return [...this.metrics.values()]
  }

  source(key: string): MetricSource | undefined {
    return this.sources.get(key)
  }

  forInterval(intervalSeconds: number): MetricDefinition[] {
    return this.all().filter((metric) => metric.evaluationIntervalSeconds === intervalSeconds)
  }

  rawForInterval(intervalSeconds: number, scope?: 'instance' | 'global'): RawMetricDefinition[] {
    return this.forInterval(intervalSeconds).filter(
      (metric): metric is RawMetricDefinition =>
        metric.kind === 'raw' && (scope === undefined || metric.scope === scope),
    )
  }

  derivedForInterval(intervalSeconds: number): DerivedMetricDefinition[] {
    return this.forInterval(intervalSeconds).filter(
      (metric): metric is DerivedMetricDefinition => metric.kind === 'derived',
    )
  }

  /** 启动校验：raw 的源存在、derived 只依赖 raw、周期为正 */
  validate(): void {
    for (const metric of this.metrics.values()) {
      if (metric.evaluationIntervalSeconds <= 0 || metric.windowSeconds <= 0) {
        throw new Error(`指标 ${metric.key} 的周期/窗口必须为正`)
      }
      if (metric.staleAfterSeconds < metric.evaluationIntervalSeconds) {
        throw new Error(`指标 ${metric.key} 的 staleAfterSeconds 不能小于评估周期`)
      }
      if (metric.kind === 'raw') {
        if (!this.sources.has(metric.source)) {
          throw new Error(`指标 ${metric.key} 引用了不存在的源：${metric.source}`)
        }
        continue
      }
      if (metric.dependsOn.length === 0) {
        throw new Error(`衍生指标 ${metric.key} 必须声明 dependsOn`)
      }
      for (const dependency of metric.dependsOn) {
        const target = this.metrics.get(dependency)
        if (!target) {
          throw new Error(`衍生指标 ${metric.key} 依赖了不存在的指标：${dependency}`)
        }
        if (target.kind !== 'raw') {
          throw new Error(`衍生指标 ${metric.key} 只能依赖 raw，收到：${dependency}`)
        }
      }
    }
  }
}
