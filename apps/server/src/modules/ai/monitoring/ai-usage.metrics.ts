import type { AiUsageDailyEntity } from '../../../database/entities/ai-usage-daily-entity.js'
import type { AiUsageDailyDimensionEntity } from '../../../database/entities/ai-usage-daily-dimension-entity.js'
import type { AiUsageDayData } from '../../ai-usage/ai-usage.service.js'
import { defineDerivedMetric, defineRawMetric } from '../../monitor/definitions/define.js'
import type { MetricDefinition, MetricPoint } from '../../monitor/definitions/metric.types.js'

const BASE = {
  category: 'business' as const,
  evaluationIntervalSeconds: 300,
  windowSeconds: 86_400,
  staleAfterSeconds: 1_200,
  scope: 'global' as const,
}

type Row = Record<string, unknown>

const num = (row: Row, field: string): number => Number(row[field] ?? 0)
const dailyPoint = (daily: AiUsageDailyEntity | null, field: string): MetricPoint[] =>
  daily ? [{ value: Number((daily as unknown as Row)[field] ?? 0) }] : []

const dimensionPoints = (
  dimensions: AiUsageDailyDimensionEntity[],
  types: readonly string[],
  field: string,
): MetricPoint[] =>
  dimensions
    .filter((row) => types.includes(row.dimensionType))
    .map((row) => ({
      value: num(row as unknown as Row, field),
      dimensionType: row.dimensionType,
      dimensionKey: row.dimensionKey,
    }))

const rawWithDimensions = (
  key: string,
  title: string,
  description: string,
  unit: 'count' | 'tokens' | 'ms',
  field: string,
  types: readonly string[],
  dimensionField = field,
): MetricDefinition =>
  defineRawMetric({
    ...BASE,
    key,
    title,
    description,
    unit,
    kind: 'raw',
    source: 'ai-usage',
    collect: ({ data }) => {
      const usage = data as AiUsageDayData
      return [
        ...dailyPoint(usage.daily, field),
        ...dimensionPoints(usage.dimensions, types, dimensionField),
      ]
    },
  })

const rawDailyOnly = (
  key: string,
  title: string,
  description: string,
  unit: 'count' | 'tokens' | 'ms',
  field: string,
): MetricDefinition =>
  defineRawMetric({
    ...BASE,
    key,
    title,
    description,
    unit,
    kind: 'raw',
    source: 'ai-usage',
    collect: ({ data }) => dailyPoint((data as AiUsageDayData).daily, field),
  })

const ratio = (numerator: number | undefined, denominator: number | undefined) => {
  if (numerator === undefined || denominator === undefined || denominator <= 0) return undefined
  return numerator / denominator
}

const derived = (
  key: string,
  title: string,
  description: string,
  dependsOn: readonly string[],
  unit: 'ratio' | 'ms' | 'count',
  calculate: (raw: (key: string) => number | undefined) => number | undefined,
): MetricDefinition =>
  defineDerivedMetric({
    ...BASE,
    key,
    title,
    description,
    unit,
    kind: 'derived',
    dependsOn,
    derive: ({ raw }) => {
      const value = calculate(raw)
      return value === undefined ? [] : [{ value }]
    },
  })

export const AI_USAGE_METRICS: readonly MetricDefinition[] = [
  rawWithDimensions('ai.usage.runs', 'AI 轮数', '根 run 数', 'count', 'runs', ['model', 'agent']),
  rawWithDimensions('ai.usage.succeeded', 'AI 成功轮数', '根 run 成功数', 'count', 'succeeded', [
    'model',
    'agent',
  ]),
  rawWithDimensions('ai.usage.failed', 'AI 失败轮数', '根 run 失败数', 'count', 'failed', [
    'model',
    'agent',
  ]),
  rawWithDimensions('ai.usage.canceled', 'AI 取消轮数', '根 run 取消数', 'count', 'canceled', [
    'model',
    'agent',
  ]),
  rawWithDimensions(
    'ai.usage.interrupted',
    'AI 中断轮数',
    '根 run 中断数',
    'count',
    'interrupted',
    ['model', 'agent'],
  ),
  rawWithDimensions('ai.usage.tokens.total', 'AI token 总量', '总 token', 'tokens', 'totalTokens', [
    'model',
    'agent',
  ]),
  rawWithDimensions(
    'ai.usage.tokens.input',
    'AI 输入 token',
    '输入 token',
    'tokens',
    'inputTokens',
    ['model', 'agent'],
  ),
  rawWithDimensions(
    'ai.usage.tokens.output',
    'AI 输出 token',
    '输出 token',
    'tokens',
    'outputTokens',
    ['model', 'agent'],
  ),
  rawWithDimensions(
    'ai.usage.tokens.cacheRead',
    'AI 缓存读 token',
    '缓存读 token',
    'tokens',
    'cacheReadTokens',
    ['model', 'agent'],
  ),
  rawWithDimensions(
    'ai.usage.tokens.cacheWrite',
    'AI 缓存写 token',
    '缓存写 token',
    'tokens',
    'cacheWriteTokens',
    ['model', 'agent'],
  ),
  rawWithDimensions(
    'ai.usage.tokens.reasoning',
    'AI 推理 token',
    '推理 token',
    'tokens',
    'reasoningTokens',
    ['model', 'agent'],
  ),
  rawDailyOnly('ai.usage.steps', 'AI 模型调用步数', 'step_count 汇总', 'count', 'steps'),
  rawDailyOnly(
    'ai.usage.conversations',
    'AI 活跃会话',
    '当天有根 run 的会话数',
    'count',
    'conversations',
  ),
  rawDailyOnly(
    'ai.usage.activeUsers',
    'AI 活跃用户',
    '当天有根 run 的用户数',
    'count',
    'activeUsers',
  ),
  rawWithDimensions(
    'ai.usage.tool.calls',
    'AI 工具调用',
    '工具调用次数',
    'count',
    'toolCalls',
    ['tool'],
    'calls',
  ),
  rawWithDimensions(
    'ai.usage.tool.succeeded',
    'AI 工具成功',
    '工具有结果',
    'count',
    'toolSucceeded',
    ['tool'],
  ),
  rawWithDimensions('ai.usage.tool.failed', 'AI 工具失败', '工具执行出错', 'count', 'toolFailed', [
    'tool',
  ]),
  rawWithDimensions('ai.usage.tool.denied', 'AI 工具被拒', '工具被拒绝', 'count', 'toolDenied', [
    'tool',
  ]),
  rawWithDimensions(
    'ai.usage.tool.invalid',
    'AI 工具入参非法',
    '工具入参不合法',
    'count',
    'toolInvalid',
    ['tool'],
  ),
  rawWithDimensions(
    'ai.usage.tool.unknown',
    'AI 未知工具',
    '模型编出的工具名',
    'count',
    'toolUnknown',
    ['tool'],
  ),
  rawWithDimensions(
    'ai.usage.tool.noResult',
    'AI 工具无结果',
    '有调用无结果',
    'count',
    'toolNoResult',
    ['tool'],
  ),
  rawDailyOnly(
    'ai.usage.firstToken.sum',
    'AI 首字延迟总和',
    'first_token_ms 汇总',
    'ms',
    'firstTokenMsSum',
  ),
  rawDailyOnly(
    'ai.usage.firstToken.count',
    'AI 首字延迟样本数',
    'first_token_ms 样本数',
    'count',
    'firstTokenRuns',
  ),
  rawDailyOnly(
    'ai.usage.duration.sum',
    'AI 轮耗时总和',
    'run duration 汇总',
    'ms',
    'runDurationMs',
  ),
  derived(
    'ai.usage.failureRate',
    'AI 失败率',
    'failed / runs',
    ['ai.usage.failed', 'ai.usage.runs'],
    'ratio',
    (raw) => ratio(raw('ai.usage.failed'), raw('ai.usage.runs')),
  ),
  derived(
    'ai.usage.successRate',
    'AI 成功率',
    'succeeded / runs',
    ['ai.usage.succeeded', 'ai.usage.runs'],
    'ratio',
    (raw) => ratio(raw('ai.usage.succeeded'), raw('ai.usage.runs')),
  ),
  derived(
    'ai.usage.toolFailureRate',
    'AI 工具失败率',
    'tool failed / calls',
    ['ai.usage.tool.failed', 'ai.usage.tool.calls'],
    'ratio',
    (raw) => ratio(raw('ai.usage.tool.failed'), raw('ai.usage.tool.calls')),
  ),
  derived(
    'ai.usage.cacheHitRate',
    'AI 缓存命中率',
    'cacheRead / input',
    ['ai.usage.tokens.cacheRead', 'ai.usage.tokens.input'],
    'ratio',
    (raw) => ratio(raw('ai.usage.tokens.cacheRead'), raw('ai.usage.tokens.input')),
  ),
  derived(
    'ai.usage.avgFirstTokenMs',
    'AI 平均首字延迟',
    'firstToken.sum / count',
    ['ai.usage.firstToken.sum', 'ai.usage.firstToken.count'],
    'ms',
    (raw) => ratio(raw('ai.usage.firstToken.sum'), raw('ai.usage.firstToken.count')),
  ),
  derived(
    'ai.usage.avgDurationMs',
    'AI 平均轮耗时',
    'duration.sum / runs',
    ['ai.usage.duration.sum', 'ai.usage.runs'],
    'ms',
    (raw) => ratio(raw('ai.usage.duration.sum'), raw('ai.usage.runs')),
  ),
  derived(
    'ai.usage.tokensPerRun',
    'AI 每轮 token',
    'tokens.total / runs',
    ['ai.usage.tokens.total', 'ai.usage.runs'],
    'count',
    (raw) => ratio(raw('ai.usage.tokens.total'), raw('ai.usage.runs')),
  ),
]
