import type { TelemetryWindow } from '@repo/kits'
import { defineRawMetric } from '../../../definitions/define.js'

export const requestP95Metric = defineRawMetric({
  key: 'request.p95',
  title: 'HTTP P95',
  description: '60 秒窗口内请求耗时 P95（ms，直方图近似）',
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
    return [{ value: histogram.quantile(0.95) }]
  },
})
