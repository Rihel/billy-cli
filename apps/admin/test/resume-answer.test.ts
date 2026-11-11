import { describe, expect, it } from 'vitest'
import { readUIMessageStream } from 'ai'
import type { UIMessage, UIMessageChunk } from 'ai'
import { markSuspendedAnswered, pinResumeMessageId } from '../src/app/(standalone)/main/ai/chat/resume-answer.ts'

/**
 * 回答完问题时的消息改写（纯逻辑，node 环境）。
 *
 * 要钉住的是「提交那一刻就变成只读问答记录」这条口径：
 * 1. 只改**这一次问答**的挂起块，其它 part 与不相关的消息保持原引用（行级 memo 才不被作废）；
 * 2. 续跑块不带问题原文，得从提交前那份挂起数据里补回来（否则只读卡片只剩答案没有题目）；
 * 3. 认块口径与续跑流一致：优先 `data.toolCallId`，退化用 part 的 `id`。
 */

const suspendedPart = (toolCallId: string | undefined, data: Record<string, unknown> = {}) =>
  ({
    type: 'data-tool-call-suspended',
    ...(toolCallId ? {} : { id: 'part-id-1' }),
    data: { toolCallId, runId: 'run_1', ...data },
  }) as never

const message = (parts: unknown[]): UIMessage =>
  ({ id: 'm1', role: 'assistant', parts }) as unknown as UIMessage

const answers = [{ id: 'q1', value: '一周内' }]

describe('pinResumeMessageId', () => {
  const chunkStream = (chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> =>
    new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })

  it('把续跑流的 start.messageId 改回原消息 id', async () => {
    const stream = pinResumeMessageId(
      chunkStream([{ type: 'start', messageId: 'new' }, { type: 'finish', finishReason: 'stop' }]),
      'seed',
    )
    const seen: string[] = []
    for await (const chunk of stream) {
      if (chunk.type === 'start') seen.push(chunk.messageId ?? '')
    }
    expect(seen).toEqual(['seed'])
  })

  it('续跑内容追加到原消息，而不是把前面的 parts 清空（用户看到的"timeline 消失"）', async () => {
    const seed = {
      id: 'seed',
      role: 'assistant',
      parts: [{ type: 'text', text: '回答之前的内容' }],
    } as unknown as UIMessage
    const chunks: UIMessageChunk[] = [
      { type: 'start', messageId: 'resumed-page' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: '续跑之后的内容' },
      { type: 'text-end', id: 't1' },
      { type: 'finish', finishReason: 'stop' },
    ]

    let last: UIMessage | undefined
    for await (const next of readUIMessageStream({
      message: seed,
      stream: pinResumeMessageId(chunkStream(chunks), seed.id),
    })) {
      last = next
    }

    const texts = (last?.parts ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
    expect(texts[0]).toBe('回答之前的内容')
    expect(texts.some((text) => text.includes('续跑之后的内容'))).toBe(true)
  })
})

describe('markSuspendedAnswered', () => {
  it('命中的挂起块被改成 resumed + answers，且补回问题原文', () => {
    const source = message([{ type: 'text', text: '先问几个问题' }, suspendedPart('call_1')])
    const next = markSuspendedAnswered(source, {
      toolCallId: 'call_1',
      answers,
      suspendPayload: { questions: [{ id: 'q1', type: 'single', title: '多久了' }] },
    })

    const part = next.parts[1] as unknown as { data: Record<string, unknown> }
    expect(part.data.resumed).toBe(true)
    expect(part.data.answers).toEqual(answers)
    expect(part.data.suspendPayload).toEqual({
      questions: [{ id: 'q1', type: 'single', title: '多久了' }],
    })
    // 其它 part 原样（引用不变）
    expect(next.parts[0]).toBe(source.parts[0])
  })

  it('取消回答：写成 resumed + cancelled + 空答案，卡片显示「已取消」而不是「已回答」', () => {
    const source = message([suspendedPart('call_1')])
    const next = markSuspendedAnswered(source, {
      toolCallId: 'call_1',
      answers: [],
      cancelled: true,
      suspendPayload: { questions: [{ id: 'q1', type: 'text', title: '给谁看？' }] },
    })

    const part = next.parts[0] as unknown as { data: Record<string, unknown> }
    expect(part.data.resumed).toBe(true)
    expect(part.data.cancelled).toBe(true)
    expect(part.data.answers).toEqual([])
    expect(part.data.suspendPayload).toEqual({
      questions: [{ id: 'q1', type: 'text', title: '给谁看？' }],
    })
  })

  it('不认识的 toolCallId：整条消息原样返回（不留无谓的新对象）', () => {
    const source = message([suspendedPart('call_1')])
    const next = markSuspendedAnswered(source, { toolCallId: 'call_other', answers })
    expect(next).toBe(source)
  })

  it('没有 toolCallId 时用 part 的 id 兜底认块', () => {
    const source = message([suspendedPart(undefined)])
    const next = markSuspendedAnswered(source, { toolCallId: 'part-id-1', answers })
    const part = next.parts[0] as unknown as { data: Record<string, unknown> }
    expect(part.data.resumed).toBe(true)
    expect(part.data.answers).toEqual(answers)
  })

  it('块里已有问题原文时不覆盖（历史回放的真实原文优先）', () => {
    const original = { questions: [{ id: 'q1', type: 'single', title: '原来的题' }] }
    const source = message([suspendedPart('call_1', { suspendPayload: original })])
    const next = markSuspendedAnswered(source, {
      toolCallId: 'call_1',
      answers,
      suspendPayload: { questions: [] },
    })
    const part = next.parts[0] as unknown as { data: Record<string, unknown> }
    expect(part.data.suspendPayload).toEqual(original)
  })

  it('幂等：同一份答案再标一次，结果一致（续跑流每帧都会调它）', () => {
    const source = message([suspendedPart('call_1')])
    const once = markSuspendedAnswered(source, { toolCallId: 'call_1', answers })
    const twice = markSuspendedAnswered(once, { toolCallId: 'call_1', answers })
    expect(twice.parts).toEqual(once.parts)
  })
})
