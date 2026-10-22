import { defineMetricRule } from '../../definitions/define.js'

export const processMemoryRule = defineMetricRule({
  key: 'system.process.memory',
  name: '进程内存使用率过高',
  description: '堆使用率超过阈值',
  category: 'system',
  metricKey: 'process.memoryRatio',
  evaluationIntervalSeconds: 60,
  windowSeconds: 60,
  instanceMode: 'per-instance',
  instanceAggregation: 'max',
  lookback: 1,
  aggregation: 'last',
  defaults: {
    enabled: true,
    operator: 'gt',
    threshold: 0.85,
    channels: ['file'],
    silenceSeconds: 300,
    level: 'warn',
    recoverAfterWindows: 2,
    notifyOnRecovery: false,
    streakWindows: 3,
  },
  fields: [
    { key: 'threshold', label: '内存使用率阈值', type: 'number', min: 0, max: 1, step: 0.01 },
    { key: 'silenceSeconds', label: '静默期（秒）', type: 'number', min: 0 },
    {
      key: 'level',
      label: '级别',
      type: 'select',
      options: [
        { label: '警告', value: 'warn' },
        { label: '错误', value: 'error' },
        { label: '严重', value: 'critical' },
      ],
    },
    {
      key: 'channels',
      label: '通知通道',
      type: 'multi-select',
      options: [
        { label: '文件', value: 'file' },
        { label: '飞书', value: 'lark' },
        { label: '邮件', value: 'email' },
      ],
    },
    { key: 'recoverAfterWindows', label: '连续未命中几轮后恢复', type: 'number', min: 1, max: 10 },
  ],
})
