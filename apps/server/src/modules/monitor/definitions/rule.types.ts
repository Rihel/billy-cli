import type { ZodType } from 'zod'
import type { MonitorRuleConfig, MonitorRuleConfigField } from '@repo/shared'
import type { MetricSample, MetricWindow } from './metric.types.js'

export type RuleLevel = 'warn' | 'error' | 'critical'

export interface RuleContext {
  now: Date
  window: MetricWindow
  params: MonitorRuleConfig
  /** 每个主体最近 lookback 个样本，以及按 aggregation 归并后的值 */
  subjects: RuleSubject[]
  /** 仅 stream 规则使用 */
  state: RuleState
}

export interface RuleSubject {
  subjectId: string
  samples: MetricSample[]
  value: number
  labels?: Record<string, string>
}

export type RuleState = Map<string, unknown>

export interface Hit {
  ruleKey: string
  subjectId: string
  value: number
  threshold?: number
  windowStart: Date
  windowEnd: Date
  labels?: Record<string, string>
  /** 触发时的样本，供告警快照使用 */
  samples?: MetricSample[]
}

export interface RuleTypeBase {
  key: string
  name: string
  description: string
  category: 'system' | 'business'
  kind: 'event' | 'metric'
  driver: 'batch' | 'stream'
  evaluationIntervalSeconds: number
  windowSeconds: number
  defaults: MonitorRuleConfig
  fields: MonitorRuleConfigField[]
  /** 后台配置的完整校验；defaults 必须能通过 */
  paramsSchema: ZodType<MonitorRuleConfig>
}

export interface MetricRuleType extends RuleTypeBase {
  kind: 'metric'
  metricKey: string
  instanceMode: 'per-instance' | 'aggregate'
  instanceAggregation: 'max' | 'sum' | 'avg'
  lookback: number
  aggregation: 'last' | 'sum' | 'avg' | 'max'
  nextState?(ctx: RuleContext, prev: RuleState): RuleState
  match(ctx: RuleContext, state: RuleState): Hit[]
}

export interface EventRuleType extends RuleTypeBase {
  kind: 'event'
  matchEvent(event: MonitorErrorEvent, config: MonitorRuleConfig): boolean
}

export type RuleType = MetricRuleType | EventRuleType

export interface MonitorErrorEvent {
  code?: number
  message: string
  stack?: string
  path?: string
  requestId?: string
  at: Date
}
