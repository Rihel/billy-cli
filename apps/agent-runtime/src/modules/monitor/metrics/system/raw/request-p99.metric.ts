import type { TelemetryWindow } from '@repo/kits'
import { defineRawMetric } from '../../../definitions/define.js'

export const requestP99Metric = defineRawMetric({
  key: 'request.p99',
  title: 'HTTP P99',
  description: '60 秒窗口内请求耗时 P99（ms，直方图近似）',
  category: 'system',
  unit: 'ms',
  evaluationIntervalSeconds: 60,
  windowSeconds: 60,
  staleAfterSeconds: 120,
  scope: 'instance',
  kind: 'raw',
  source: 'telemetry',
  collect: ({ data }) => {
    const window = data as TelemetryWindow
    const histogram = window.histograms['request.duration']
    if (!histogram || histogram.count === 0) return []
    return [{ value: histogram.quantile(0.99) }]
  },
})
