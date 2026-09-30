import { describe, expect, it } from 'vitest'
import {
  cacheHitPercentText,
  compactNumber,
  durationText,
  exactNumberText,
  tokenText,
  usageLineText,
  usageLineTitle,
} from '../src/app/main/ai/chat/format.ts'

/**
 * 统计行的数字与文案格式化。
 *
 * 用户看到的现象是"统计数字不对"，所以这里把口径钉死：
 * k / m 缩写、一位小数、去掉多余的 `.0`、缓存命中用**百分比**、缺失显示 `—`（**不编造 0**）。
 */

const USAGE = {
  inputTokens: 4464,
  outputTokens: 218,
  totalTokens: 4682,
  cacheReadTokens: 2816,
  reasoningTokens: 120,
  stepCount: 2,
  durationMs: 1234,
}

describe('compactNumber', () => {
  it('小于 1000 原样显示', () => {
    expect(compactNumber(0)).toBe('0')
    expect(compactNumber(7)).toBe('7')
    expect(compactNumber(999)).toBe('999')
  })

  it('千位 / 百万位用 k / m，保留一位小数', () => {
    expect(compactNumber(1000)).toBe('1k')
    expect(compactNumber(3179)).toBe('3.2k')
    expect(compactNumber(29_610)).toBe('29.6k')
    expect(compactNumber(1_250_000)).toBe('1.3m')
    expect(compactNumber(2_000_000)).toBe('2m')
  })

  it('进位后不要出现 `1000k` 这种怪值（自动升级单位）', () => {
    const text = compactNumber(999_960)
    expect(text).toMatch(/m$/)
    expect(text).toBe('1m')
  })

  it('负数（理论上不该有，但要稳定）', () => {
    expect(compactNumber(-3179)).toBe('-3.2k')
  })

  it('缺失 / 非数字 → null（调用方显示"—"，不编造 0）', () => {
    expect(compactNumber(null)).toBeNull()
    expect(compactNumber(undefined)).toBeNull()
    expect(compactNumber(Number.NaN)).toBeNull()
    expect(compactNumber('123')).toBeNull()
  })
})

describe('tokenText / exactNumberText / durationText', () => {
  it('token：缩写，缺失显示 —', () => {
    expect(tokenText(3179)).toBe('3.2k')
    expect(tokenText(null)).toBe('—')
    expect(tokenText(undefined)).toBe('—')
  })

  it('精确值：千分位（悬停提示用）', () => {
    expect(exactNumberText(3179)).toBe('3,179')
    expect(exactNumberText(null)).toBeNull()
  })

  it('耗时：<1s 用毫秒，否则用秒', () => {
    expect(durationText(820)).toBe('820ms')
    expect(durationText(1000)).toBe('1s')
    expect(durationText(1234)).toBe('1.2s')
    expect(durationText(null)).toBe('—')
  })
})

describe('cacheHitPercentText（缓存命中率）', () => {
  it('命中 ÷ 输入，取整百分比（与实测口径一致：DeepSeek 的输入含命中）', () => {
    expect(cacheHitPercentText({ inputTokens: 5991, cacheReadTokens: 4352 })).toBe('73%')
    expect(cacheHitPercentText({ inputTokens: 4520, cacheReadTokens: 2944 })).toBe('65%')
    expect(cacheHitPercentText({ inputTokens: 1650, cacheReadTokens: 1408 })).toBe('85%')
  })

  it('命中 0 是"报了 0"→ 0%；没上报 / 输入为 0 → null（整段不显示，不编造 0%）', () => {
    expect(cacheHitPercentText({ inputTokens: 1000, cacheReadTokens: 0 })).toBe('0%')
    expect(cacheHitPercentText({ inputTokens: 1000 })).toBeNull()
    expect(cacheHitPercentText({ cacheReadTokens: 10 })).toBeNull()
    expect(cacheHitPercentText({ inputTokens: 0, cacheReadTokens: 0 })).toBeNull()
    expect(cacheHitPercentText(null)).toBeNull()
  })
})

describe('usageLineText（右下角那一行）', () => {
  it('形如 `N 轮 M 步，输入 X，输出 Y，缓存命中 Z%`', () => {
    expect(usageLineText(USAGE, 3)).toBe('3 轮 2 步，输入 4.5k，输出 218，缓存命中 63%')
  })

  it('没有缓存命中数据时，连"缓存命中"四个字都不出现（不编造 0%）', () => {
    const { cacheReadTokens: _drop, ...noCache } = USAGE
    expect(usageLineText(noCache, 1)).toBe('1 轮 2 步，输入 4.5k，输出 218')
  })

  it('输入 / 输出缺失也照常显示 —（它们是这一行的骨架，缺了要用 — 占位）', () => {
    expect(usageLineText({ stepCount: 1 }, 1)).toBe('1 轮 1 步，输入 —，输出 —')
  })

  it('没有用量（还没跑过）→ null（整行不渲染）', () => {
    expect(usageLineText(null, 1)).toBeNull()
  })
})

describe('usageLineTitle（悬停精确值）', () => {
  it('逐段校验：每段内容正确、没有多余空白', () => {
    // 逐段断言（而不是比对整串）：分隔符固定是 ` · `，任一段带多余空格都会在这里露出来
    expect(usageLineTitle(USAGE, 3).split(' · ')).toEqual([
      '3 轮',
      '2 步',
      '输入 4,464',
      '输出 218',
      '合计 4,682',
      '缓存命中 63%（2,816）',
      '推理 120',
      '耗时 1.2s',
    ])
  })

  it('缺失的项整段不出现（缓存 / 推理没上报就没有那一段）', () => {
    const segments = usageLineTitle(
      { inputTokens: 100, outputTokens: 5, totalTokens: 105, stepCount: 1, durationMs: 500 },
      1,
    ).split(' · ')
    expect(segments).toEqual(['1 轮', '1 步', '输入 100', '输出 5', '合计 105', '耗时 500ms'])
  })
})
