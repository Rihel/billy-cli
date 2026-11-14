import { compare, defineMetricRule } from '../../definitions/define.js'
import type { Hit, RuleContext, RuleState } from '../../definitions/rule.types.js'

interface StreakState {
  count: number
}

/**
 * 连续 N 个窗口错误率越线：stream 驱动示例。
 * 每主体在 Redis 里累积连续命中次数，达到 streakWindows 才产告警。
 */
export const httpErrorStreakRule = defineMetricRule({
  key: 'system.http.error-rate.streak',
  name: 'HTTP 错误率连续越线',
  description: '连续 N 个 60 秒窗口错误率超过阈值',
  category: 'system',
  driver: 'stream',
  metricKey: 'request.errorRate',
  evaluationIntervalSeconds: 60,
  windowSeconds: 60,
  instanceMode: 'per-instance',
  instanceAggregation: 'max',
  lookback: 1,
  aggregation: 'last',
  defaults: {
    enabled: false,
    operator: 'gt',
    threshold: 0.05,
    channels: ['file'],
    silenceSeconds: 300,
    level: 'error',
    recoverAfterWindows: 2,
    notifyOnRecovery: false,
    streakWindows: 3,
  },
  fields: [
    { key: 'threshold', label: '错误率阈值', type: 'number', min: 0, max: 1, step: 0.01 },
    { key: 'streakWindows', label: '连续窗口数', type: 'number', min: 1, max: 30 },
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
  nextState(ctx: RuleContext, prev: RuleState): RuleState {
    const next: RuleState = new Map(prev)
    const currentSubjects = new Set(ctx.subjects.map((subject) => subject.subjectId))
    for (const subject of ctx.subjects) {
      const previous = (next.get(subject.subjectId) as StreakState | undefined) ?? { count: 0 }
      if (compare(subject.value, ctx.params.operator, ctx.params.threshold)) {
        next.set(subject.subjectId, { count: previous.count + 1 })
      } else {
        next.delete(subject.subjectId)
      }
    }
    // 主体消失（实例下线）时清掉状态，避免泄漏
    for (const subjectId of next.keys()) {
      if (!currentSubjects.has(subjectId)) next.delete(subjectId)
    }
    return next
  },
  match(ctx: RuleContext, state: RuleState): Hit[] {
    const hits: Hit[] = []
    for (const [subjectId, raw] of state) {
      const streak = (raw as StreakState).count
      if (streak < ctx.params.streakWindows) continue
      const subject = ctx.subjects.find((item) => item.subjectId === subjectId)
      if (!subject) continue
      hits.push({
        ruleKey: '',
        subjectId,
        value: streak,
        threshold: ctx.params.streakWindows,
        windowStart: ctx.window.start,
        windowEnd: ctx.window.end,
        samples: subject.samples,
      })
    }
    return hits
  },
})
