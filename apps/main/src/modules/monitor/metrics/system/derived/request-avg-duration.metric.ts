import { defineDerivedMetric } from '../../../definitions/define.js'

export const requestAvgDurationMetric = defineDerivedMetric({
  key: 'request.avgDuration',
  title: 'HTTP 平均耗时',
  description: '耗时总和 / 样本数（ms）',
  category: 'system',
  unit: 'ms',
  evaluationIntervalSeconds: 60,
  windowSeconds: 60,
  staleAfterSeconds: 120,
  scope: 'instance',
  kind: 'derived',
  dependsOn: ['request.duration.sum', 'request.duration.count'],
  derive: ({ raw }) => {
    const sum = raw('request.duration.sum')
    const count = raw('request.duration.count')
    if (sum === undefined || count === undefined || count <= 0) return []
    return [{ value: sum / count }]
  },
})
