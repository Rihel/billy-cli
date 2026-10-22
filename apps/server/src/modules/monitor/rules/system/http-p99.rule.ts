import { defineMetricRule } from '../../definitions/define.js'

export const httpP99Rule = defineMetricRule({
  key: 'system.http.p99',
  name: 'HTTP P99 过高',
  description: '60 秒窗口内请求耗时 P99 超过阈值',
  category: 'system',
  metricKey: 'request.p99',
  evaluationIntervalSeconds: 60,
  windowSeconds: 60,
  instanceMode: 'per-instance',
  instanceAggregation: 'max',
  lookback: 1,
  aggregation: 'last',
  defaults: {
    enabled: true,
    operator: 'gt',
    threshold: 1000,
    channels: ['file'],
    silenceSeconds: 300,
    level: 'warn',
    recoverAfterWindows: 2,
    notifyOnRecovery: false,
    streakWindows: 3,
  },
  fields: [
    { key: 'threshold', label: 'P99 阈值（ms）', type: 'number', min: 0 },
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
