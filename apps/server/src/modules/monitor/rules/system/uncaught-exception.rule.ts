import { defineEventRule } from '../../definitions/define.js'

export const uncaughtExceptionRule = defineEventRule({
  key: 'system.error.uncaught',
  name: '未捕获异常',
  description: '出现未捕获异常 / 未处理 Promise 时告警',
  category: 'system',
  evaluationIntervalSeconds: 60,
  windowSeconds: 60,
  defaults: {
    enabled: true,
    operator: 'gte',
    threshold: 1,
    channels: ['file'],
    silenceSeconds: 300,
    level: 'critical',
    recoverAfterWindows: 2,
    notifyOnRecovery: false,
    streakWindows: 3,
    matchCodes: [],
    keywords: [],
  },
  fields: [
    { key: 'threshold', label: '窗口内触发次数', type: 'number', min: 1 },
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
  ],
})
