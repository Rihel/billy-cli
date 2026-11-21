import { describe, expect, it } from 'vitest'
import {
  collapsedMaxHeightOf,
  isOverflowing,
  resolveLineHeightPx,
  USER_MESSAGE_COLLAPSED_LINES,
} from '../src/app/(app)/(standalone)/main/ai/chat/user-message-clamp.ts'

/**
 * 用户消息折叠口径：**10 行**。
 *
 * 这里钉三件事：阈值是 10 行、`line-height: normal` 有确定性兜底（否则量不出来就不折叠）、
 * 刚好 10 行不能出「展开」按钮（+1px 的亚像素容差）。
 */
describe('collapsedMaxHeightOf', () => {
  it('10 行 × 行高', () => {
    expect(USER_MESSAGE_COLLAPSED_LINES).toBe(10)
    expect(collapsedMaxHeightOf(24)).toBe(240)
    expect(collapsedMaxHeightOf(21.5)).toBeCloseTo(215)
  })
})

describe('resolveLineHeightPx', () => {
  it('正常的 px 行高直接采用', () => {
    expect(resolveLineHeightPx('24px', '14px')).toBe(24)
  })

  it('`normal` 时退回 fontSize × 1.6（14px → 22.4）', () => {
    expect(resolveLineHeightPx('normal', '14px')).toBeCloseTo(22.4)
  })

  it('拿不到任何数字时给 24px 兜底，保证不会退化成不折叠', () => {
    expect(resolveLineHeightPx('', '')).toBe(24)
  })
})

describe('isOverflowing', () => {
  it('正好 10 行不算溢出（容差 1px）', () => {
    expect(isOverflowing(240, 24)).toBe(false)
    expect(isOverflowing(240.8, 24)).toBe(false)
  })

  it('第 11 行才出按钮', () => {
    expect(isOverflowing(264, 24)).toBe(true)
  })
})
