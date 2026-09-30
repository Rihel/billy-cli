import { describe, expect, it } from 'vitest'
import { mergeUsage, toUsageRecord } from '../src/modules/ai/runtime/usage.js'

/**
 * 用量折算口径（主 run 与子 run 共用）。
 *
 * 钉住的是**实测过的真实形状**（DeepSeek 走 `@ai-sdk/deepseek` 时 Mastra 给出的 `totalUsage`）：
 * 缓存命中在**顶层 `cachedInputTokens`**，推理 token 在**顶层 `reasoningTokens`**；
 * 嵌套的 `inputTokenDetails.*` 在该适配下是空的 —— 早先只读嵌套那处，
 * 于是界面上的"缓存命中"永远是 `null`（用户反馈的现象）。
 */
describe('toUsageRecord', () => {
  it('顶层字段优先：cachedInputTokens / reasoningTokens 都要收进来', () => {
    // 实测样本（第 2 次请求命中缓存）
    const record = toUsageRecord({
      inputTokens: 1650,
      outputTokens: 62,
      totalTokens: 1712,
      cachedInputTokens: 1408,
      reasoningTokens: 60,
      raw: { raw: { prompt_cache_hit_tokens: 1408, prompt_cache_miss_tokens: 242 } },
    })
    expect(record).toEqual({
      inputTokens: 1650,
      outputTokens: 62,
      totalTokens: 1712,
      cacheReadTokens: 1408,
      cacheWriteTokens: null,
      reasoningTokens: 60,
    })
  })

  it('嵌套形态兜底（`inputTokenDetails.cacheReadTokens` / `outputTokenDetails.reasoningTokens`）', () => {
    expect(
      toUsageRecord({
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        inputTokenDetails: { cacheReadTokens: 7, cacheWriteTokens: 3 },
        outputTokenDetails: { reasoningTokens: 1 },
      }),
    ).toMatchObject({ cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 1 })
  })

  it('没上报就是 null（不编造 0）；整个 usage 缺失 → null', () => {
    expect(toUsageRecord({ inputTokens: 1 })).toEqual({
      inputTokens: 1,
      outputTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    })
    expect(toUsageRecord(null)).toBeNull()
    expect(toUsageRecord(undefined)).toBeNull()
    // 命中 0 是"报了 0"（真实值），不是"没上报"
    expect(toUsageRecord({ cachedInputTokens: 0 })?.cacheReadTokens).toBe(0)
  })
})

describe('mergeUsage（父 + 子逐字段相加）', () => {
  it('全空字段仍是 null，不变成 0', () => {
    expect(mergeUsage({ totalTokens: 10 }, { totalTokens: 5 })).toMatchObject({
      totalTokens: 15,
      cacheReadTokens: null,
    })
  })

  it('一份都没有 → null', () => {
    expect(mergeUsage(null, undefined)).toBeNull()
  })
})
