import { Inject, Injectable } from '@nestjs/common'
import type { MetricPoint, MetricSample, MetricWindow } from '../definitions/metric.types.js'
import { MetricRegistry } from './metric.registry.js'
import { MetricSampleRepository } from './metric-sample.repository.js'

/** 衍生指标：读同窗口 raw → 计算 → 写 derived 样本 */
@Injectable()
export class DerivedMetricService {
  constructor(
    @Inject(MetricRegistry) private readonly metrics: MetricRegistry,
    @Inject(MetricSampleRepository) private readonly samples: MetricSampleRepository,
  ) {}

  async compute(intervalSeconds: number, window: MetricWindow, instanceId: string): Promise<void> {
    const derivedMetrics = this.metrics.derivedForInterval(intervalSeconds)
    if (derivedMetrics.length === 0) return

    for (const metric of derivedMetrics) {
      const deps = [...metric.dependsOn]
      const dimensions = await this.samples.dimensionsOf(deps, window.key, instanceId)
      if (dimensions.length === 0) continue

      const points: MetricPoint[] = []
      for (const dimension of dimensions) {
        const values = await this.samples.rawValues(
          deps,
          window.key,
          instanceId,
          dimension.dimensionType,
          dimension.dimensionKey,
        )
        const derived = await metric.derive({
          window,
          instanceId,
          dimensionType: dimension.dimensionType,
          dimensionKey: dimension.dimensionKey,
          raw: (key) => values.get(key),
        })
        for (const point of derived) {
          points.push({
            ...point,
            dimensionType: point.dimensionType ?? dimension.dimensionType,
            dimensionKey: point.dimensionKey ?? dimension.dimensionKey,
          })
        }
      }

      const samples: MetricSample[] = points.map((point) => ({
        metricKey: metric.key,
        metricKind: 'derived',
        windowKey: window.key,
        windowStart: window.start,
        windowEnd: window.end,
        instanceId,
        dimensionType: point.dimensionType ?? 'total',
        dimensionKey: point.dimensionKey ?? '',
        value: point.value,
        labels: point.labels,
      }))
      await this.samples.upsertMany(samples)
    }
  }
}
