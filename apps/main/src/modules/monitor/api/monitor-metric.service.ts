import { Inject, Injectable } from '@nestjs/common'
import type {
  MonitorMetricDefinitionModel,
  MonitorMetricLatestModel,
  MonitorMetricLatestQueryDto,
  MonitorMetricPointModel,
  MonitorMetricSeriesDto,
  MonitorMetricSeriesModel,
} from '@repo/shared'
import { MetricRegistry } from '../engine/metric.registry.js'
import { MetricSampleRepository } from '../engine/metric-sample.repository.js'
import { MonitorMetricNotFoundError } from '../errors.js'

/** 指标读模型：历史 / 最新值 */
@Injectable()
export class MonitorMetricService {
  constructor(
    @Inject(MetricRegistry) private readonly metrics: MetricRegistry,
    @Inject(MetricSampleRepository) private readonly samples: MetricSampleRepository,
  ) {}

  definitions(): MonitorMetricDefinitionModel[] {
    return this.metrics.all().map((metric) => ({
      key: metric.key,
      title: metric.title,
      description: metric.description,
      kind: metric.kind,
      category: metric.category,
      unit: metric.unit,
      evaluationIntervalSeconds: metric.evaluationIntervalSeconds,
      windowSeconds: metric.windowSeconds,
      scope: metric.scope,
      ...(metric.kind === 'derived' ? { dependsOn: [...metric.dependsOn] } : {}),
    }))
  }

  async series(query: MonitorMetricSeriesDto): Promise<MonitorMetricSeriesModel> {
    if (!this.metrics.get(query.metricKey)) {
      throw new MonitorMetricNotFoundError(query.metricKey)
    }
    const rows = await this.samples.series(query)
    const points: MonitorMetricPointModel[] = rows.map((row) => ({
      windowKey: row.windowKey,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      value: row.value,
      instanceId: row.instanceId,
      dimensionType: row.dimensionType,
      dimensionKey: row.dimensionKey,
    }))
    return { metricKey: query.metricKey, points }
  }

  async latest(query: MonitorMetricLatestQueryDto): Promise<MonitorMetricLatestModel[]> {
    for (const key of query.metricKeys) {
      if (!this.metrics.get(key)) throw new MonitorMetricNotFoundError(key)
    }
    const rows = await this.samples.latest(
      query.metricKeys,
      query.dimensionType,
      query.dimensionKey,
    )
    return rows.map((row) => ({
      metricKey: row.metricKey,
      value: row.value,
      windowKey: row.windowKey,
      windowEnd: row.windowEnd,
      instanceId: row.instanceId,
      dimensionType: row.dimensionType,
      dimensionKey: row.dimensionKey,
    }))
  }
}
