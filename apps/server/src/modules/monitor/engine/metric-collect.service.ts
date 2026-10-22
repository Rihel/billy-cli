import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, type TelemetryWindow } from '@repo/kits'
import type {
  MetricDefinition,
  MetricPoint,
  MetricSample,
  MetricWindow,
  RawMetricDefinition,
} from '../definitions/metric.types.js'
import { alignedWindow, dayWindow, windowFromTelemetry } from '../definitions/window.js'
import { MetricRegistry } from './metric.registry.js'
import { MetricSampleRepository } from './metric-sample.repository.js'
import { DerivedMetricService } from './derived-metric.service.js'
import { MonitorInstanceService } from './instance.service.js'

/** 指标采集：读源 → raw 指标 → 写 raw 样本；派生交给 DerivedMetricService */
@Injectable()
export class MetricCollectService {
  constructor(
    @Inject(MetricRegistry) private readonly metrics: MetricRegistry,
    @Inject(MetricSampleRepository) private readonly samples: MetricSampleRepository,
    @Inject(DerivedMetricService) private readonly derived: DerivedMetricService,
    @Inject(MonitorInstanceService) private readonly instance: MonitorInstanceService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 所有实例都执行：采集本实例的进程内指标 */
  async collectInstance(intervalSeconds: number): Promise<void> {
    const raws = this.metrics.rawForInterval(intervalSeconds, 'instance')
    if (raws.length === 0) return

    const bySource = this.groupBySource(raws)
    const now = new Date()
    const cache = new Map<string, unknown>()

    for (const [sourceKey, metrics] of bySource) {
      const source = this.metrics.source(sourceKey)
      if (!source) {
        this.logger.error('monitor.source.missing', { sourceKey })
        continue
      }

      let data: unknown
      try {
        data = await source.read({
          now,
          window: alignedWindow(intervalSeconds, now),
          instanceId: this.instance.id,
        })
      } catch (error) {
        this.logger.error('monitor.source.failed', { sourceKey, error })
        continue
      }

      const windows =
        sourceKey === 'telemetry'
          ? ((data as TelemetryWindow[]).map((window) =>
              windowFromTelemetry(window.windowStartAt, window.windowEndAt),
            ) as MetricWindow[])
          : [alignedWindow(intervalSeconds, now)]

      for (let index = 0; index < windows.length; index++) {
        const window = windows[index]
        const windowData =
          sourceKey === 'telemetry'
            ? (data as TelemetryWindow[])[index]
            : data
        await this.collectRaw(metrics, window, windowData, cache)
        await this.derived.compute(intervalSeconds, window, this.instance.id)
      }
    }
  }

  /** 只有 leader 执行：采集全局指标（P1 为空，AI 日表在 P2） */
  async collectGlobal(intervalSeconds: number): Promise<void> {
    const raws = this.metrics.rawForInterval(intervalSeconds, 'global')
    if (raws.length === 0) return

    const bySource = this.groupBySource(raws)
    const now = new Date()
    const cache = new Map<string, unknown>()

    for (const [sourceKey, metrics] of bySource) {
      const source = this.metrics.source(sourceKey)
      if (!source) {
        this.logger.error('monitor.source.missing', { sourceKey })
        continue
      }
      const window = metrics.some((metric) => metric.windowSeconds >= 86_400)
        ? dayWindow(now)
        : alignedWindow(intervalSeconds, now)
      let data: unknown
      try {
        data = await source.read({ now, window, instanceId: '' })
      } catch (error) {
        this.logger.error('monitor.source.failed', { sourceKey, error })
        continue
      }
      await this.collectRaw(metrics, window, data, cache)
      await this.derived.compute(intervalSeconds, window, '')
    }
  }

  private groupBySource(metrics: readonly RawMetricDefinition[]): Map<string, RawMetricDefinition[]> {
    const bySource = new Map<string, RawMetricDefinition[]>()
    for (const metric of metrics) {
      const bucket = bySource.get(metric.source) ?? []
      bucket.push(metric)
      bySource.set(metric.source, bucket)
    }
    return bySource
  }

  private async collectRaw(
    metrics: readonly RawMetricDefinition[],
    window: MetricWindow,
    data: unknown,
    cache: Map<string, unknown>,
  ): Promise<void> {
    const samples: MetricSample[] = []
    for (const metric of metrics) {
      let points: MetricPoint[]
      try {
        points = await metric.collect({
          window,
          instanceId: metric.scope === 'instance' ? this.instance.id : '',
          data,
          cache,
        })
      } catch (error) {
        this.logger.error('monitor.metric.collect_failed', { metricKey: metric.key, error })
        continue
      }
      for (const point of points) {
        samples.push(this.sampleOf(metric, window, point))
      }
    }
    await this.samples.upsertMany(samples)
  }

  private sampleOf(
    metric: MetricDefinition,
    window: MetricWindow,
    point: MetricPoint,
  ): MetricSample {
    return {
      metricKey: metric.key,
      metricKind: metric.kind,
      windowKey: window.key,
      windowStart: window.start,
      windowEnd: window.end,
      instanceId: metric.scope === 'instance' ? this.instance.id : '',
      dimensionType: point.dimensionType ?? 'total',
      dimensionKey: point.dimensionKey ?? '',
      value: point.value,
      labels: point.labels,
    }
  }
}
