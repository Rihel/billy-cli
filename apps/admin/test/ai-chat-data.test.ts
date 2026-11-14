import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import {
  currentTurnUsage,
  sessionUsageOf,
} from '../src/app/(app)/(standalone)/main/ai/chat/data.ts'

/**
 * 右下角统计的两个取数口：
 * - `sessionUsageOf`：**整个会话累计**（行内显示的就是它，用户口径：步与 token 都是所有轮次之和）；
 * - `currentTurnUsage`：本轮那笔（只进悬停）。
 *
 * 这个文件是**一致性测试**（服务端块形状 ↔ 前端读取）：踩过一次层级错位 ——
 * 服务端把 token 放在 `data.usage` 里（外层还有 `stepCount` / `durationMs`），
 * 前端直接返回了 `data`，于是界面行内只剩"轮 / 步"是真的、**token 全是"—"**（用户截图指出）。
 *
 * 另一条钉住的规则（2026-11-14 用户指出）：`6 轮 1 步` 那种"轮是序号、步是本轮次数"的读法不成立，
 * 步数与 token 必须跨轮累加。
 */

/** 造一条带 `data-run-usage` 的 assistant 消息 */
const assistantWith = (data: Record<string, unknown>): UIMessage =>
  ({
    id: 'a1',
    role: 'assistant',
    parts: [{ type: 'data-run-usage', data }],
  }) as unknown as UIMessage

/** 造一条 assistant 消息，parts 原样给（用来造实时块 / 多块顺序） */
const assistantParts = (parts: unknown[]): UIMessage =>
  ({ id: 'a-parts', role: 'assistant', parts }) as unknown as UIMessage

/** 造一条"没有用量块"的 assistant 消息（失败的轮 / 正在跑的第一步） */
const assistantWithoutUsage = (): UIMessage =>
  ({
    id: 'a-empty',
    role: 'assistant',
    parts: [{ type: 'text', text: '答' }],
  }) as unknown as UIMessage

/** 一条 user 消息 */
const user = (id: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text: '再来' }] }) as unknown as UIMessage

describe('sessionUsageOf（会话累计）', () => {
  it('按服务端真实形状取值：token 在 data.usage 里、stepCount 在外层（拍平后相加）', () => {
    const snapshot = sessionUsageOf([
      assistantWith({
        runId: 'run_1',
        usage: { inputTokens: 4464, outputTokens: 218, totalTokens: 4682, cacheReadTokens: 2816 },
        stepCount: 2,
        durationMs: 1234,
      }),
    ])
    expect(snapshot?.turns).toBe(1)
    expect(snapshot?.usage).toMatchObject({
      inputTokens: 4464,
      outputTokens: 218,
      totalTokens: 4682,
      cacheReadTokens: 2816,
      stepCount: 2,
      durationMs: 1234,
    })
  })

  it('多轮累计：步数与 token 逐轮相加，轮数 = 助手消息条数', () => {
    const snapshot = sessionUsageOf([
      assistantWith({
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        stepCount: 2,
      }),
      user('u2'),
      assistantWith({
        usage: { inputTokens: 500, outputTokens: 50, totalTokens: 550 },
        stepCount: 3,
      }),
    ])
    expect(snapshot?.turns).toBe(2)
    expect(snapshot?.usage).toMatchObject({
      inputTokens: 600,
      outputTokens: 60,
      totalTokens: 660,
      stepCount: 5,
    })
  })

  it('没有用量的轮（失败 / 第一步还没跑完）也计入轮数，但不往合计里加', () => {
    const snapshot = sessionUsageOf([
      assistantWith({ usage: { inputTokens: 100, outputTokens: 10 }, stepCount: 2 }),
      user('u2'),
      assistantWithoutUsage(),
    ])
    expect(snapshot?.turns).toBe(2)
    expect(snapshot?.usage).toMatchObject({ inputTokens: 100, stepCount: 2 })
  })

  it('每条消息取**最新**用量块：实时块与收尾块并存时用收尾（含子 agent / 命名的并账）', () => {
    const snapshot = sessionUsageOf([
      assistantParts([
        {
          type: 'data-step-usage',
          data: { stepCount: 1, usage: { inputTokens: 100, outputTokens: 10 } },
        },
        {
          type: 'data-run-usage',
          data: {
            stepCount: 2,
            usage: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 256 },
          },
        },
      ]),
    ])
    expect(snapshot?.usage).toMatchObject({ inputTokens: 300, stepCount: 2, cacheReadTokens: 256 })
  })

  it('轮内实时块单独也能累加（历史 + 实时混在同一份消息里）', () => {
    const snapshot = sessionUsageOf([
      assistantWith({ usage: { inputTokens: 1000, outputTokens: 100 }, stepCount: 4 }),
      user('u2'),
      assistantParts([
        {
          type: 'data-step-usage',
          data: { stepCount: 1, usage: { inputTokens: 200, outputTokens: 20 } },
        },
        {
          type: 'data-step-usage',
          data: { stepCount: 2, usage: { inputTokens: 500, outputTokens: 45 } },
        },
      ]),
    ])
    expect(snapshot?.turns).toBe(2)
    expect(snapshot?.usage).toMatchObject({ inputTokens: 1500, outputTokens: 145, stepCount: 6 })
  })

  it('缺字段不编 0：某轮没上报的字段不加，全都没上报 → null（整行不渲染）', () => {
    const snapshot = sessionUsageOf([
      assistantWith({ usage: { inputTokens: 100, outputTokens: 10 }, stepCount: 1 }),
      user('u2'),
      assistantWith({ usage: { inputTokens: 50 }, stepCount: 1 }),
    ])
    // outputTokens 只有第一轮报了 → 合计 10（不是按第二轮补 0 再算别的）
    expect(snapshot?.usage).toMatchObject({ inputTokens: 150, outputTokens: 10, stepCount: 2 })
    // 一整条都没有 token 字段的块 → 这次会话没有可用用量
    expect(sessionUsageOf([assistantWith({ runId: 'r', usage: {}, stepCount: 0 })])).toBeNull()
    expect(sessionUsageOf([])).toBeNull()
  })
})

describe('currentTurnUsage（本轮，只进悬停）', () => {
  it('取最新一条 assistant 的用量；没有就 null（**不**回退上一轮）', () => {
    const messages = [
      assistantWith({ usage: { inputTokens: 100, outputTokens: 10 }, stepCount: 2 }),
      user('u2'),
      assistantParts([
        {
          type: 'data-step-usage',
          data: { stepCount: 1, usage: { inputTokens: 42, outputTokens: 4 } },
        },
      ]),
    ]
    expect(currentTurnUsage(messages)).toMatchObject({ inputTokens: 42, stepCount: 1 })

    // 最新一轮第一步还没跑完 → 没有本轮数字（悬停里就不出现"本轮"那行）
    expect(
      currentTurnUsage([
        assistantWith({ usage: { inputTokens: 100, outputTokens: 10 }, stepCount: 2 }),
        user('u2'),
        assistantWithoutUsage(),
      ]),
    ).toBeNull()
    expect(currentTurnUsage([])).toBeNull()
  })
})
