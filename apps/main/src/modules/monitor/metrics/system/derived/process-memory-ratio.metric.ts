import { defineDerivedMetric } from '../../../definitions/define.js'

export const processMemoryRatioMetric = defineDerivedMetric({
  key: 'process.memoryRatio',
  title: '进程堆使用率',
  description: 'heapUsed / heapTotal',
  category: 'system',
  unit: 'ratio',
  evaluationIntervalSeconds: 60,
  windowSeconds: 60,
  staleAfterSeconds: 120,
  scope: 'instance',
  kind: 'derived',
  dependsOn: ['process.memory.used', 'process.memory.total'],
  derive: ({ raw }) => {
    const used = raw('process.memory.used')
    const total = raw('process.memory.total')
    if (used === undefined || total === undefined || total <= 0) return []
    return [{ value: used / total }]
  },
})
