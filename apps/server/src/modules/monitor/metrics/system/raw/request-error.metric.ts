import type { TelemetryWindow } from '@repo/kits'
import { defineRawMetric } from '../../../definitions/define.js'

export const requestErrorMetric = defineRawMetric({
  key: 'request.error',
  title: 'HTTP 5xx 请求数',
  description: '60 秒窗口内 5xx 请求数',
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
    return [{ value: window.counters['request.error'] ?? 0 }]
  },
})
