import type { MonitorRuleConfigField } from '@repo/shared'
import { defineMetricRule } from '../../monitor/definitions/define.js'
import type { MetricRuleType } from '../../monitor/definitions/rule.types.js'

const fields: MonitorRuleConfigField[] = [
  { key: 'threshold', label: '阈值', type: 'number', min: 0 },
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
]

const base = {
  category: 'business' as const,
  evaluationIntervalSeconds: 300,
  windowSeconds: 86_400,
  instanceMode: 'aggregate' as const,
  instanceAggregation: 'max' as const,
  lookback: 1,
  aggregation: 'last' as const,
  fields,
}

/** AI 用量规则：默认关闭，管理员按实际模型 / 流量显式启用 */
export const AI_USAGE_RULES: readonly MetricRuleType[] = [
  defineMetricRule({
    ...base,
    key: 'ai.usage.daily-tokens',
    name: 'AI 日 token 水位',
    description: '当天累计 token 超过水位',
    metricKey: 'ai.usage.tokens.total',
    defaults: {
      enabled: false,
      operator: 'gte',
      threshold: 1_000_000,
      channels: ['file'],
      silenceSeconds: 1_800,
      level: 'warn',
      recoverAfterWindows: 2,
      notifyOnRecovery: false,
      streakWindows: 3,
      dimensionType: 'total',
    },
  }),
  defineMetricRule({
    ...base,
    key: 'ai.usage.failure-rate',
    name: 'AI 失败率过高',
    description: '当天失败率超过阈值',
    metricKey: 'ai.usage.failureRate',
    defaults: {
      enabled: false,
      operator: 'gte',
      threshold: 0.1,
      channels: ['file'],
      silenceSeconds: 1_800,
      level: 'warn',
      recoverAfterWindows: 2,
      notifyOnRecovery: false,
      streakWindows: 3,
      dimensionType: 'total',
    },
  }),
  defineMetricRule({
    ...base,
    key: 'ai.usage.tool-failure-rate',
    name: 'AI 工具失败率过高',
    description: '当天工具失败率超过阈值',
    metricKey: 'ai.usage.toolFailureRate',
    defaults: {
      enabled: false,
      operator: 'gte',
      threshold: 0.2,
      channels: ['file'],
      silenceSeconds: 1_800,
      level: 'warn',
      recoverAfterWindows: 2,
      notifyOnRecovery: false,
      streakWindows: 3,
      dimensionType: 'total',
    },
  }),
  defineMetricRule({
    ...base,
    key: 'ai.usage.first-token',
    name: 'AI 首字延迟过高',
    description: '当天平均首字延迟超过阈值',
    metricKey: 'ai.usage.avgFirstTokenMs',
    defaults: {
      enabled: false,
      operator: 'gte',
      threshold: 8_000,
      channels: ['file'],
      silenceSeconds: 1_800,
      level: 'warn',
      recoverAfterWindows: 2,
      notifyOnRecovery: false,
      streakWindows: 3,
      dimensionType: 'total',
    },
  }),
]
