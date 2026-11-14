import { TimelineKind, TimelineRole } from '@repo/shared'
import { describe, expect, it } from 'vitest'
import { toParts } from '../src/app/(app)/(standalone)/main/ai/chat/history'

/** 历史重建：压缩产物 → 会话里的「已压缩」卡片 part */
describe('历史重建：上下文摘要', () => {
  it('summary 事件还原成 data-summary part（正文 + 覆盖区间）', () => {
    const parts = toParts([
      {
        seq: 9,
        role: TimelineRole.System,
        kind: TimelineKind.Summary,
        payload: { text: '早前聊了周报与待办', coversSeqs: [[1, 12]] },
      },
    ] as never)

    const card = parts.find((part) => part.type === 'data-summary') as
      | { data?: { text?: string; covers?: string } }
      | undefined
    expect(card?.data?.text).toBe('早前聊了周报与待办')
    expect(card?.data?.covers).toBe('1–12')
  })

  it('没有正文的摘要不产生空卡片', () => {
    const parts = toParts([
      { seq: 1, role: TimelineRole.System, kind: TimelineKind.Summary, payload: {} },
    ] as never)
    expect(parts.some((part) => part.type === 'data-summary')).toBe(false)
  })
})
