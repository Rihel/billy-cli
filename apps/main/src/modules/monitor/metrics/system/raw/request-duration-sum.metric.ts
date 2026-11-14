import type { TelemetryWindow } from '@repo/kits'
import { defineRawMetric } from '../../../definitions/define.js'

export const requestDurationSumMetric = defineRawMetric({
  key: 'request.duration.sum',
  title: '请求耗时总和',
  description: '60 秒窗口内请求耗时总和（ms）',
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
    if (!histogram) return []
    return [{ value: histogram.sum }]
  },
})
