import type { TelemetryWindow } from '@repo/kits'
import { defineRawMetric } from '../../../definitions/define.js'

export const requestDurationCountMetric = defineRawMetric({
  key: 'request.duration.count',
  title: '请求耗时样本数',
  description: '60 秒窗口内请求耗时样本数',
  category: 'system',
  unit: 'count',
  evaluationIntervalSeconds: 60,
  windowSeconds: 60,
  staleAfterSeconds: 120,
  scope: 'instance',
  kind: 'raw',
  source: 'telemetry',
  collect: ({ data }) => {
    const window = data as TelemetryWindow
    const histogram = window.histograms['request.duration']
    if (!histogram) return []
    return [{ value: histogram.count }]
  },
})
