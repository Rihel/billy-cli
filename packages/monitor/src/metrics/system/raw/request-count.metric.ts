import type { TelemetryWindow } from '@repo/kits'
import { defineRawMetric } from '../../../definitions/define.js'

export const requestCountMetric = defineRawMetric({
  key: 'request.count',
  title: 'HTTP 请求数',
  description: '60 秒窗口内完成的请求数（计数，不是 QPS）',
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
    return [{ value: window.counters['request.count'] ?? 0 }]
  },
})
