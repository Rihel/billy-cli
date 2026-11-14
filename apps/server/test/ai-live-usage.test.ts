import { describe, expect, it } from 'vitest'
import { createLiveUsage, stepUsageOf } from '../src/modules/ai/runtime/live-usage.js'

/**
 * 轮内**实时用量**（`data-step-usage`）：单测钉住两条口径 ——
 * 1. 从 Mastra 的 `step-finish` 里读哪块、怎么累加（`output.usage` 累加 / `totalUsage` 覆盖）；
 * 2. 包装后的 UI 流里，`data-step-usage` **一定出现在同一步的 `finish-step` 之后**，
 *    且是"到目前为止"的累计值 —— 前端右下角那一行就靠它边跑边涨。
 *
 * 为什么把流造出来测：踩过的坑是"v6 适配层把 step 的 usage 丢了"（见 `live-usage.ts` 顶部注释），
 * 只测纯函数证明不了注入点真的接上了。
 */

/** Mastra 原始流片段（只造我们关心的最小面） */
const rawStreamOf = (chunks: unknown[]): ReadableStream<Record<string, unknown>> =>
  new ReadableStream<Record<string, unknown>>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk as Record<string, unknown>)
      controller.close()
    },
  })

/** 收一条包装后的流里的全部片段 */
const drain = async (stream: ReadableStream<unknown>): Promise<Record<string, unknown>[]> => {
  const out: Record<string, unknown>[] = []
  const reader = stream.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    out.push(next.value as Record<string, unknown>)
  }
  return out
}

/** 一步的模型调用：`output.usage` 是这一步自己的账 */
const stepFinish = (inputTokens: number, outputTokens: number, cachedInputTokens: number) => ({
  type: 'step-finish',
  payload: {
    // 真实 Mastra 片段的最小面：适配器要读 `metadata` 与 `stepResult.reason`
    metadata: {},
    stepResult: { reason: 'stop', warnings: [] },
    output: {
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cachedInputTokens,
      },
    },
  },
})

describe('stepUsageOf', () => {
  it('`output.usage` 是这一步的账 → delta；缓存命中读顶层 cachedInputTokens', () => {
    expect(stepUsageOf(stepFinish(100, 20, 30))).toEqual({
      mode: 'delta',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cacheReadTokens: 30,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    })
  })

  it('只有 `totalUsage` 时当**累计快照**（覆盖，不再累加）', () => {
    const reading = stepUsageOf({
      type: 'step-finish',
      payload: {
        metadata: {},
        stepResult: { reason: 'stop' },
        totalUsage: { inputTokens: 500, outputTokens: 50, totalTokens: 550 },
      },
    })
    expect(reading?.mode).toBe('snapshot')
    expect(reading?.usage).toMatchObject({ inputTokens: 500 })
  })

  it('不是 step-finish / 没有用量 → null（不编造 0）', () => {
    expect(stepUsageOf({ type: 'text-delta' })).toBeNull()
    expect(stepUsageOf({ type: 'step-finish', payload: {} })).toBeNull()
  })
})

describe('createLiveUsage().wrap', () => {
  it('每步结束发一条 `data-step-usage`：步数递增、token 累计、插在 finish-step 之后', async () => {
    const live = createLiveUsage({ runId: 'run_1', startedAt: Date.now() })
    const chunks = await drain(
      live.wrap({
        fullStream: rawStreamOf([
          { type: 'start', payload: { messageId: 'm1' } },
          { type: 'step-start', payload: {} },
          stepFinish(100, 20, 30),
          { type: 'step-start', payload: {} },
          stepFinish(200, 40, 60),
          { type: 'finish', payload: { stepResult: { reason: 'stop' } } },
        ]),
      }),
    )

    const usageChunks = chunks.filter((chunk) => chunk.type === 'data-step-usage')
    expect(usageChunks).toHaveLength(2)
    expect(usageChunks[0]?.data).toMatchObject({
      runId: 'run_1',
      stepCount: 1,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 },
    })
    expect(usageChunks[1]?.data).toMatchObject({
      stepCount: 2,
      usage: { inputTokens: 300, outputTokens: 60, cacheReadTokens: 90 },
    })
    // 位置：同一步的 `finish-step` 之后 —— 前端收到它时这一步确实已经结束
    const firstFinishStep = chunks.findIndex((chunk) => chunk.type === 'finish-step')
    const firstUsage = chunks.findIndex((chunk) => chunk.type === 'data-step-usage')
    expect(firstFinishStep).toBeGreaterThanOrEqual(0)
    expect(firstUsage).toBeGreaterThan(firstFinishStep)
  })

  it('续跑基数生效：恢复后第一份就是"这一轮到目前为止"，不从 0 重数', async () => {
    const live = createLiveUsage({
      runId: 'run_2',
      startedAt: Date.now(),
      baseUsage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cacheReadTokens: 800 },
      baseSteps: 3,
      baseDurationMs: 5_000,
    })
    const chunks = await drain(
      live.wrap({
        fullStream: rawStreamOf([
          stepFinish(10, 1, 4),
          { type: 'finish', payload: { stepResult: { reason: 'stop' } } },
        ]),
      }),
    )
    const data = chunks.find((chunk) => chunk.type === 'data-step-usage')?.data as {
      stepCount: number
      durationMs: number
      usage: Record<string, unknown>
    }
    expect(data.stepCount).toBe(4)
    expect(data.durationMs).toBeGreaterThanOrEqual(5_000)
    expect(data.usage).toMatchObject({ inputTokens: 1010, outputTokens: 101, cacheReadTokens: 804 })
  })

  it('没有 fullStream（直接给流）时退回原路径：流照常出，只是没有实时块', async () => {
    const live = createLiveUsage({ runId: 'run_3', startedAt: Date.now() })
    const chunks = await drain(live.wrap(rawStreamOf([stepFinish(1, 1, 0)])))
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.filter((chunk) => chunk.type === 'data-step-usage')).toHaveLength(0)
  })
})
