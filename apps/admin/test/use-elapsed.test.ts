import { describe, expect, it } from 'vitest'
import {
  elapsedSecondsOf,
  finalSecondsOf,
} from '../src/app/(app)/(standalone)/main/ai/chat/use-elapsed.ts'

/**
 * 计时口径：运行中**按整秒**（向下取整），结束给**向上取整**的最终秒数。
 *
 * 为什么不再用 500ms 采样 + 一位小数：采样 0.5s 而显示 0.1s 精度，数字会按 0.5 一跳
 * （0ms → 500ms → 1s → 1.5s），停下来那一刻还会比真实耗时少一截（用户反馈"怪怪的"）。
 */
describe('elapsedSecondsOf', () => {
  it('运行中按整秒向下取整：跨过秒边界才翻字', () => {
    expect(elapsedSecondsOf(0, 0)).toBe(0)
    expect(elapsedSecondsOf(0, 999)).toBe(0)
    expect(elapsedSecondsOf(0, 1000)).toBe(1)
    expect(elapsedSecondsOf(0, 1999)).toBe(1)
    expect(elapsedSecondsOf(0, 2000)).toBe(2)
  })

  it('时钟回拨（now < startedAt）也不出现负数', () => {
    expect(elapsedSecondsOf(1000, 500)).toBe(0)
  })
})

describe('finalSecondsOf', () => {
  it('结束冻结在向上取整的整秒：0.2s 也算 1s', () => {
    expect(finalSecondsOf(0, 200)).toBe(1)
    expect(finalSecondsOf(0, 1000)).toBe(1)
    expect(finalSecondsOf(0, 1001)).toBe(2)
    expect(finalSecondsOf(0, 3400)).toBe(4)
  })
})
