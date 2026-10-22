import { defineDerivedMetric } from '../../../definitions/define.js'

export const requestErrorRateMetric = defineDerivedMetric({
  key: 'request.errorRate',
  title: 'HTTP 错误率',
  description: '同一 60 秒窗口内 5xx 请求数 / 请求数',
  category: 'system',
  unit: 'ratio',
  evaluationIntervalSeconds: 60,
  windowSeconds: 60,
  staleAfterSeconds: 120,
  scope: 'instance',
  kind: 'derived',
  dependsOn: ['request.error', 'request.count'],
  derive: ({ raw }) => {
    const total = raw('request.count')
    const errors = raw('request.error')
    if (total === undefined || errors === undefined || total <= 0) return []
    return [{ value: errors / total }]
  },
})
