import { defineDerivedMetric } from '../../../definitions/define.js'

export const requestQpsMetric = defineDerivedMetric({
  key: 'request.qps',
  title: 'HTTP QPS',
  description: '请求数 / 窗口秒数',
  category: 'system',
  unit: 'count',
  evaluationIntervalSeconds: 60,
  windowSeconds: 60,
  staleAfterSeconds: 120,
  scope: 'instance',
  kind: 'derived',
  dependsOn: ['request.count'],
  derive: ({ raw, window }) => {
    const count = raw('request.count')
    if (count === undefined) return []
    const seconds = Math.max((window.end.getTime() - window.start.getTime()) / 1000, 1)
    return [{ value: count / seconds }]
  },
})
