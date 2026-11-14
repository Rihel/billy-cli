import { defineRawMetric } from '../../../definitions/define.js'
import type { ProcessMemory } from '../../../sources/process.source.js'

export const processMemoryTotalMetric = defineRawMetric({
  key: 'process.memory.total',
  title: '进程堆总量',
  description: 'process.memoryUsage().heapTotal（bytes）',
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
    return [{ value: memory.total }]
  },
})
