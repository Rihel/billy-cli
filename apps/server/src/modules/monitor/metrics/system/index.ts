import type { MetricDefinition } from '../../definitions/metric.types.js'
import * as raw from './raw/index.js'
import * as derived from './derived/index.js'

export const SYSTEM_METRICS: readonly MetricDefinition[] = [
  raw.requestCountMetric,
  raw.requestErrorMetric,
  raw.requestDurationSumMetric,
  raw.requestDurationCountMetric,
  raw.requestP95Metric,
  raw.requestP99Metric,
  raw.processMemoryUsedMetric,
  raw.processMemoryTotalMetric,
  derived.requestErrorRateMetric,
  derived.requestQpsMetric,
  derived.requestAvgDurationMetric,
  derived.processMemoryRatioMetric,
]
