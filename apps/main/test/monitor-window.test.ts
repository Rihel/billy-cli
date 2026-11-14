import { describe, expect, it } from 'vitest'
import { aggregate } from '../src/modules/monitor/definitions/aggregate.js'
import { alignedWindow, dayWindow } from '../src/modules/monitor/definitions/window.js'

describe('监控窗口与归并', () => {
  it('alignedWindow 按评估周期对齐，key 用窗口起点 ISO', () => {
    const now = new Date('2026-10-21T14:32:45.123Z')
    const window = alignedWindow(60, now)
    expect(window.start.toISOString()).toBe('2026-10-21T14:31:00.000Z')
    expect(window.end.toISOString()).toBe('2026-10-21T14:32:00.000Z')
    expect(window.key).toBe(window.start.toISOString())
  })

  it('dayWindow 按 Asia/Shanghai 的当天 00:00 起算', () => {
    const now = new Date('2026-10-21T16:30:00.000Z') // 上海 2026-10-22 00:30
    const window = dayWindow(now)
    expect(window.key).toBe('2026-10-22')
    expect(window.start.toISOString()).toBe('2026-10-21T16:00:00.000Z')
  })

  it('aggregate 支持 last / sum / avg / max', () => {
    expect(aggregate([3, 2, 1], 'last')).toBe(3)
    expect(aggregate([3, 2, 1], 'sum')).toBe(6)
    expect(aggregate([3, 2, 1], 'avg')).toBe(2)
    expect(aggregate([3, 2, 1], 'max')).toBe(3)
    expect(aggregate([], 'sum')).toBe(0)
  })
})

import { httpErrorStreakRule } from '../src/modules/monitor/rules/system/http-error-streak.rule.js'
import type { RuleContext, RuleState } from '../src/modules/monitor/definitions/rule.types.js'

describe('stream 规则：连续 N 个窗口越线', () => {
  const ctx = (value: number, state: RuleState): RuleContext => ({
    now: new Date('2026-10-21T14:32:00.000Z'),
    window: {
      key: '2026-10-21T14:31:00.000Z',
      start: new Date('2026-10-21T14:31:00.000Z'),
      end: new Date('2026-10-21T14:32:00.000Z'),
    },
    params: {
      ...httpErrorStreakRule.defaults,
      streakWindows: 2,
    },
    subjects: [
      {
        subjectId: 'instance:a',
        value,
        samples: [],
      },
    ],
    state,
  })

  it('连续两个窗口越线才命中；中间回到阈值下会重置', () => {
    let state: RuleState = new Map()
    state = httpErrorStreakRule.nextState!(ctx(0.2, state), state)
    expect(httpErrorStreakRule.match(ctx(0.2, state), state)).toHaveLength(0)

    state = httpErrorStreakRule.nextState!(ctx(0.2, state), state)
    const hits = httpErrorStreakRule.match(ctx(0.2, state), state)
    expect(hits).toHaveLength(1)
    expect(hits[0].value).toBe(2)

    state = httpErrorStreakRule.nextState!(ctx(0.01, state), state)
    expect(state.size).toBe(0)
  })
})
