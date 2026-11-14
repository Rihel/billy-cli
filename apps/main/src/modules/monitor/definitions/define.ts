import { MonitorRuleConfigSchema, type MonitorRuleConfig } from '@repo/shared'
import type { ZodType } from 'zod'
import type {
  EventRuleType,
  Hit,
  MetricRuleType,
  MonitorErrorEvent,
  RuleContext,
} from './rule.types.js'
import type { DerivedMetricDefinition, RawMetricDefinition } from './metric.types.js'

/** 数值比较 */
export function compare(
  value: number,
  operator: MonitorRuleConfig['operator'],
  threshold: number,
): boolean {
  switch (operator) {
    case 'gt':
      return value > threshold
    case 'gte':
      return value >= threshold
    case 'lt':
      return value < threshold
    case 'lte':
      return value <= threshold
    default:
      return false
  }
}

/** 最常见的阈值判定：逐主体比较 `subject.value` */
export function matchThreshold(ctx: RuleContext): Hit[] {
  return ctx.subjects
    .filter((subject) => compare(subject.value, ctx.params.operator, ctx.params.threshold))
    .map((subject) => ({
      ruleKey: '',
      subjectId: subject.subjectId,
      value: subject.value,
      threshold: ctx.params.threshold,
      windowStart: ctx.window.start,
      windowEnd: ctx.window.end,
      labels: subject.labels,
      samples: subject.samples,
    }))
}

type MetricRuleInput = Omit<
  MetricRuleType,
  'kind' | 'driver' | 'match' | 'paramsSchema' | 'nextState'
> & {
  driver?: MetricRuleType['driver']
  nextState?: MetricRuleType['nextState']
  match?: MetricRuleType['match']
  paramsSchema?: ZodType<MonitorRuleConfig>
}

/** 定义一条指标规则；不写 match 时用阈值判定 */
export function defineMetricRule(input: MetricRuleInput): MetricRuleType {
  return {
    ...input,
    kind: 'metric',
    driver: input.driver ?? 'batch',
    paramsSchema: input.paramsSchema ?? MonitorRuleConfigSchema,
    match: input.match ?? matchThreshold,
  }
}

type EventRuleInput = Omit<EventRuleType, 'kind' | 'driver' | 'paramsSchema' | 'matchEvent'> & {
  driver?: EventRuleType['driver']
  paramsSchema?: ZodType<MonitorRuleConfig>
  matchEvent?: (event: MonitorErrorEvent, config: MonitorRuleConfig) => boolean
}

/** 定义一条事件规则；不写 matchEvent 时按错误码 / 关键字匹配 */
export function defineEventRule(input: EventRuleInput): EventRuleType {
  return {
    ...input,
    kind: 'event',
    driver: input.driver ?? 'batch',
    paramsSchema: input.paramsSchema ?? MonitorRuleConfigSchema,
    matchEvent: input.matchEvent ?? matchByCodeOrKeyword,
  }
}

/** 默认事件匹配：错误码 / 关键字为空表示不限 */
export function matchByCodeOrKeyword(event: MonitorErrorEvent, config: MonitorRuleConfig): boolean {
  const codes = config.matchCodes ?? []
  const keywords = config.keywords ?? []
  if (codes.length > 0 && (event.code === undefined || !codes.includes(event.code))) {
    return false
  }
  if (keywords.length > 0 && !keywords.some((keyword) => event.message.includes(keyword))) {
    return false
  }
  return true
}

/** 原始指标定义辅助（保留类型推断） */
export const defineRawMetric = <T extends RawMetricDefinition>(def: T): T => def

/** 衍生指标定义辅助 */
export const defineDerivedMetric = <T extends DerivedMetricDefinition>(def: T): T => def
