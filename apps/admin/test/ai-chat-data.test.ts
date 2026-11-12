import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { lastRunUsage } from '../src/app/(app)/(standalone)/main/ai/chat/data.ts'

/**
 * `lastRunUsage`：从消息里取"最近一轮"的用量。
 *
 * 这个文件是**一致性测试**（服务端块形状 ↔ 前端读取）：踩过一次层级错位 ——
 * 服务端把 token 放在 `data.usage` 里（外层还有 `stepCount` / `durationMs`），
 * 前端直接返回了 `data`，于是界面行内只剩"轮 / 步"是真的、**token 全是"—"**（用户截图指出）。
 */

/** 造一条 assistant 消息，parts 里放一个 `data-run-usage` */
const assistantWith = (data: Record<string, unknown>): UIMessage =>
  ({
    id: 'a1',
    role: 'assistant',
    parts: [{ type: 'data-run-usage', data }],
  }) as unknown as UIMessage

describe('lastRunUsage', () => {
  it('按服务端真实形状取值：token 在 data.usage 里（并拍平外层字段）', () => {
    // 与 `chat.service.ts` 的 usageChunk 完全一致的形状
    const usage = lastRunUsage([
      assistantWith({
        runId: 'run_1',
        usage: { inputTokens: 4464, outputTokens: 218, totalTokens: 4682, cacheReadTokens: 2816 },
        stepCount: 2,
        toolCallCount: 1,
        durationMs: 1234,
      }),
    ])

    expect(usage).toEqual({
      inputTokens: 4464,
      outputTokens: 218,
      totalTokens: 4682,
      cacheReadTokens: 2816,
      stepCount: 2,
      toolCallCount: 1,
      durationMs: 1234,
    })
  })

  it('历史重建的形状（`history.ts` 从 runs 合成）同样能取到', () => {
    const usage = lastRunUsage([
      assistantWith({
        runId: 'run_1',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        stepCount: 1,
        toolCallCount: 0,
        durationMs: 800,
      }),
    ])
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 20, stepCount: 1 })
  })

  it('取**最后一条** assistant 的块（多轮会话看最近一轮）', () => {
    const usage = lastRunUsage([
      assistantWith({ usage: { inputTokens: 1, outputTokens: 1 }, stepCount: 1 }),
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: '再来' }] },
      assistantWith({ usage: { inputTokens: 9, outputTokens: 9 }, stepCount: 3 }),
    ] as UIMessage[])
    expect(usage).toMatchObject({ inputTokens: 9, stepCount: 3 })
  })

  it('没有用量块 / usage 缺失 → null（调用方整行不渲染，不编造 0）', () => {
    expect(lastRunUsage([])).toBeNull()
    expect(
      lastRunUsage([
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '答' }] },
      ] as UIMessage[]),
    ).toBeNull()
    // 有块但 usage 为 null / 一个 token 字段都没有 → null：
    // 不显示成"3 轮 1 步，输入 —，输出 —"这种半截行（用户截到的就是这个）
    expect(lastRunUsage([assistantWith({ runId: 'r', usage: null, stepCount: 0 })])).toBeNull()
    expect(lastRunUsage([assistantWith({ runId: 'r', usage: {}, stepCount: 0 })])).toBeNull()
  })
})
