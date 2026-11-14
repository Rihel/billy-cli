import { defineRawMetric } from '../../../definitions/define.js'
import type { ProcessMemory } from '../../../sources/process.source.js'

export const processMemoryUsedMetric = defineRawMetric({
  key: 'process.memory.used',
  title: '进程堆已用',
  description: 'process.memoryUsage().heapUsed（bytes）',
  category: 'system',
  unit: 'bytes',
  evaluationIntervalSeconds: 60,
  windowSeconds: 60,
  staleAfterSeconds: 120,
  scope: 'instance',
  kind: 'raw',
  source: 'process',
  collect: ({ data }) => {
    const memory = data as ProcessMemory
    return [{ value: memory.used }]
  },
})
