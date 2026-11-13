import { describe, expect, it } from 'vitest'
import { fitMessagesToToolBudget } from '../src/modules/ai/runtime/turn-budget.js'
import { toolFailureOf } from '../src/modules/ai/runtime/stream-recorder.js'

/**
 * 轮内上下文预算：每一步前把工具结果的累计体积压回预算。
 *
 * 钉住四件事：
 * 1. 没超线时**一个字节都不动**（不能因为"反正是旧结果"就无谓地牺牲信息）；
 * 2. 超线时**从最旧开始压**，最近 4 条完整保留（模型下一步还要用）；
 * 3. 两种消息形态都认（Mastra 的库消息 / AI SDK 的模型消息），认不出来就不压；
 * 4. **不改原对象**：只产出新数组，原消息（可能要写回 Mastra 的记忆）保持完整。
 */
const mastraMessage = (id: string, result: unknown) => ({
  id,
  role: 'assistant',
  content: {
    format: 2,
    parts: [
      { type: 'text', text: '调用工具' },
      { type: 'tool-invocation', toolInvocation: { toolCallId: id, state: 'result', result } },
    ],
  },
})

const sdkMessage = (id: string, output: unknown) => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: 'demo', output }],
})

const big = (chars: number) => 'x'.repeat(chars)

describe('轮内工具结果预算', () => {
  it('未超预算：原样返回，不计截断', () => {
    const messages = [mastraMessage('a', big(100)), mastraMessage('b', big(100))]
    const result = fitMessagesToToolBudget(messages, { budgetChars: 10_000 })
    expect(result.trimmedCount).toBe(0)
    expect(result.messages).toEqual(messages)
    expect(result.beforeChars).toBe(result.afterChars)
  })

  it('超预算：从最旧开始压，最近 4 条不动', () => {
    const messages = Array.from({ length: 6 }, (_, index) => mastraMessage(`t${index}`, big(5_000)))
    const result = fitMessagesToToolBudget(messages, { budgetChars: 8_000, keepRecent: 4 })

    expect(result.trimmedCount).toBeGreaterThan(0)
    // 最近 4 条本身就超过预算，所以只能"尽量压"：压的必须是旧的，总量必须下降
    expect(result.afterChars).toBeLessThan(result.beforeChars)

    const partsOf = (index: number) =>
      (result.messages[index] as { content: { parts: Array<Record<string, unknown>> } }).content
        .parts[1]
    // 最旧的两条被压成"截断标记 + 预览"
    const oldest = partsOf(0).toolInvocation as { result: { truncated?: boolean } }
    expect(oldest.result.truncated).toBe(true)
    // 最近 4 条保持原样
    const newest = partsOf(5).toolInvocation as { result: string }
    expect(newest.result).toBe(big(5_000))
  })

  it('AI SDK 形态（content 数组里的 tool-result）也认', () => {
    const messages = [
      sdkMessage('a', { type: 'json', value: { items: big(5_000) } }),
      sdkMessage('b', { type: 'json', value: { items: big(5_000) } }),
      sdkMessage('c', { type: 'json', value: { items: big(5_000) } }),
    ]
    const result = fitMessagesToToolBudget(messages, { budgetChars: 4_000, keepRecent: 1 })
    expect(result.trimmedCount).toBeGreaterThan(0)
    expect(result.beforeChars).toBeGreaterThan(result.afterChars)
  })

  it('不改原对象：入参消息保持完整（只产出新数组）', () => {
    const original = mastraMessage('a', big(5_000))
    const snapshot = JSON.stringify(original)
    const result = fitMessagesToToolBudget([original, mastraMessage('b', big(100))], {
      budgetChars: 1_000,
      keepRecent: 0,
    })
    expect(result.trimmedCount).toBe(2)
    expect(JSON.stringify(original)).toBe(snapshot)
  })

  it('认不出的形态：不压、不报错（压错比不压更糟）', () => {
    const result = fitMessagesToToolBudget([{ foo: 'bar' }, null, 42], { budgetChars: 0 })
    expect(result.trimmedCount).toBe(0)
    expect(result.messages).toHaveLength(3)
  })
})

describe('工具把失败当结果返回（ok: false）', () => {
  it('顶层 ok:false 认成失败，并取一条可读原因', () => {
    expect(toolFailureOf({ ok: false, reason: '没有第 3 章' })).toEqual({
      failed: true,
      message: '没有第 3 章',
    })
    expect(toolFailureOf({ ok: false, message: '写库失败' }).message).toBe('写库失败')
    expect(toolFailureOf({ ok: false }).failed).toBe(true)
  })

  it('正常结果 / ok:true / 非对象：都不算失败', () => {
    expect(toolFailureOf({ ok: true, data: 1 }).failed).toBe(false)
    expect(toolFailureOf({ valid: false, errors: ['缺标题'] }).failed).toBe(false)
    expect(toolFailureOf('plain text').failed).toBe(false)
    expect(toolFailureOf(null).failed).toBe(false)
    expect(toolFailureOf([{ ok: false }]).failed).toBe(false)
  })
})
