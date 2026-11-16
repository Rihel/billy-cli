import { describe, expect, it } from 'vitest'
import {
  AGUI_CUSTOM,
  AgUiEventType,
  agUiEventToChunks,
  createAgUiDecodeState,
  encodeAgUiChunk,
  isAgUiEvent,
  isRunFinalEvent,
  parseAgUiSse,
  type AgUiChunk,
} from '../src/agui'

/**
 * AG-UI 编解码与 SSE 解析。
 *
 * 钉住的是**协议契约**：事件名、字段、工具入参累积、业务 CUSTOM 信封、
 * 以及"事件 → chunk → 事件"关键字段不丢 —— 网关回退口与补发整形都靠这份互逆。
 */

const ctx = { threadId: 'conv-1', runId: 'run-1', messageId: 'msg-1' }

describe('encodeAgUiChunk', () => {
  it('文本 / 推理各成对出现，messageId 用 part id', () => {
    const start = encodeAgUiChunk({ type: 'text-start', id: 'text-1' }, ctx)
    expect(start).toMatchObject([
      { type: AgUiEventType.TEXT_MESSAGE_START, messageId: 'text-1', role: 'assistant' },
    ])
    const delta = encodeAgUiChunk({ type: 'text-delta', id: 'text-1', delta: '你' }, ctx)
    expect(delta[0]).toMatchObject({
      type: AgUiEventType.TEXT_MESSAGE_CONTENT,
      messageId: 'text-1',
      delta: '你',
    })

    const reasoning = encodeAgUiChunk({ type: 'reasoning-start', id: 'r-1' }, ctx)
    expect(reasoning[0]).toMatchObject({
      type: AgUiEventType.REASONING_MESSAGE_START,
      messageId: 'r-1',
      role: 'reasoning',
    })
  })

  it('工具链：入参靠 ARGS 累积，END 不带 input，结果单独给出参', () => {
    expect(
      encodeAgUiChunk({ type: 'tool-input-start', toolCallId: 'call-1', toolName: 'bash' }, ctx)[0],
    ).toMatchObject({
      type: AgUiEventType.TOOL_CALL_START,
      toolCallId: 'call-1',
      toolCallName: 'bash',
      parentMessageId: 'msg-1',
    })
    expect(
      encodeAgUiChunk(
        { type: 'tool-input-delta', toolCallId: 'call-1', inputTextDelta: '{"a":' },
        ctx,
      )[0],
    ).toMatchObject({
      type: AgUiEventType.TOOL_CALL_ARGS,
      toolCallId: 'call-1',
      delta: '{"a":',
    })
    expect(encodeAgUiChunk({ type: 'tool-input-available', toolCallId: 'call-1' }, ctx)[0]).toEqual(
      {
        type: AgUiEventType.TOOL_CALL_END,
        toolCallId: 'call-1',
        timestamp: expect.any(Number),
      },
    )
    expect(
      encodeAgUiChunk(
        { type: 'tool-output-available', toolCallId: 'call-1', output: { ok: true } },
        ctx,
      )[0],
    ).toMatchObject({
      type: AgUiEventType.TOOL_CALL_RESULT,
      toolCallId: 'call-1',
      content: '{"ok":true}',
      role: 'tool',
    })
  })

  it('业务扩展走 CUSTOM，统一包 { data } 信封（裸载荷也是）', () => {
    // 裸载荷型也必须包一层：否则解码端无法区分"信封"和"业务载荷自己带 data 字段"
    expect(encodeAgUiChunk({ type: 'data-plan', data: { tasks: [] } }, ctx)[0]).toMatchObject({
      type: AgUiEventType.CUSTOM,
      name: AGUI_CUSTOM.plan,
      value: { data: { tasks: [] } },
    })
    expect(
      encodeAgUiChunk({ type: 'data-sub-agent', id: 'sub-1', data: { status: 'running' } }, ctx)[0],
    ).toMatchObject({
      type: AgUiEventType.CUSTOM,
      name: AGUI_CUSTOM.subAgent,
      value: { kind: 'data-sub-agent', id: 'sub-1', data: { status: 'running' } },
    })
    expect(encodeAgUiChunk({ type: 'data-step-usage', data: { tokens: 1 } }, ctx)[0]).toMatchObject(
      {
        type: AgUiEventType.CUSTOM,
        name: AGUI_CUSTOM.usage,
        value: { kind: 'data-step-usage', data: { tokens: 1 } },
      },
    )
  })

  it('收尾用 RUN_FINISHED，错误用 RUN_ERROR，认不出的块进 RAW', () => {
    expect(encodeAgUiChunk({ type: '__run_end__' }, ctx)[0]).toMatchObject({
      type: AgUiEventType.RUN_FINISHED,
      threadId: 'conv-1',
      runId: 'run-1',
    })
    expect(encodeAgUiChunk({ type: 'error', errorText: '炸了' }, ctx)[0]).toMatchObject({
      type: AgUiEventType.RUN_ERROR,
      message: '炸了',
    })
    expect(encodeAgUiChunk({ type: 'brand-new-chunk', x: 1 }, ctx)[0]).toMatchObject({
      type: AgUiEventType.RAW,
      event: { type: 'brand-new-chunk', x: 1 },
    })
  })
})

describe('CUSTOM 解码的信封口径', () => {
  const custom = (name: string, value: unknown) =>
    agUiEventToChunks({ type: AgUiEventType.CUSTOM, name, value } as never, createAgUiDecodeState())

  it('新格式：裸载荷型也走 { data } 信封，解回业务载荷', () => {
    expect(custom(AGUI_CUSTOM.plan, { data: { tasks: [] } })).toEqual([
      { type: 'data-plan', data: { tasks: [] } },
    ])
    expect(custom(AGUI_CUSTOM.status, { data: { status: 'running' } })).toEqual([
      { type: 'data-status', data: { status: 'running' } },
    ])
  })

  it('旧记录：裸载荷自己带 data 字段时整份保留（不再误剥一层）', () => {
    // 旧编码不包信封；业务载荷里本来就有 data 字段（JSON 类结果）
    const payload = { name: 'diff', data: { lines: 2 } }
    expect(custom(AGUI_CUSTOM.plan, payload)).toEqual([{ type: 'data-plan', data: payload }])
  })

  it('旧记录：没有 data 字段的裸载荷照常解出', () => {
    expect(custom(AGUI_CUSTOM.title, { title: '新标题' })).toEqual([
      { type: 'data-conversation-title', data: { title: '新标题' } },
    ])
  })

  it('信封型（带 id 的业务卡）仍从信封里取 data', () => {
    expect(custom(AGUI_CUSTOM.toolEvent, { id: 'call-1', data: { kind: 'x' } })).toEqual([
      { type: 'data-tool-event', id: 'call-1', data: { kind: 'x' } },
    ])
  })
})

describe('agUiEventToChunks', () => {
  it('工具入参跨事件累积，END 时给出完整 input', () => {
    const state = createAgUiDecodeState()
    agUiEventToChunks(
      {
        type: AgUiEventType.TOOL_CALL_START,
        toolCallId: 'call-9',
        toolCallName: 'write',
      } as never,
      state,
    )
    agUiEventToChunks(
      { type: AgUiEventType.TOOL_CALL_ARGS, toolCallId: 'call-9', delta: '{"path":' } as never,
      state,
    )
    const out = agUiEventToChunks(
      { type: AgUiEventType.TOOL_CALL_ARGS, toolCallId: 'call-9', delta: '"/a.txt"}' } as never,
      state,
    )
    expect(out).toEqual([
      { type: 'tool-input-delta', toolCallId: 'call-9', inputTextDelta: '"/a.txt"}' },
    ])
    const end = agUiEventToChunks(
      { type: AgUiEventType.TOOL_CALL_END, toolCallId: 'call-9' } as never,
      state,
    )
    expect(end[0]).toMatchObject({
      type: 'tool-input-available',
      toolCallId: 'call-9',
      toolName: 'write',
      input: { path: '/a.txt' },
    })
  })

  it('CUSTOM 逆映射回原有 chunk 形状', () => {
    expect(
      agUiEventToChunks({
        type: AgUiEventType.CUSTOM,
        name: AGUI_CUSTOM.subAgent,
        value: { kind: 'data-sub-agent-delta', id: 'sub-1', data: { delta: 'x' } },
      } as never),
    ).toEqual([{ type: 'data-sub-agent-delta', id: 'sub-1', data: { delta: 'x' } }])
    expect(
      agUiEventToChunks({
        type: AgUiEventType.CUSTOM,
        name: AGUI_CUSTOM.message,
        value: { messageId: 'msg-1' },
      } as never),
    ).toEqual([{ type: 'start', messageId: 'msg-1' }])
  })

  it('编码 → 解码关键字段不丢（文本 / 工具 / 收尾）', () => {
    const chunks: AgUiChunk[] = [
      { type: 'start', messageId: 'msg-1' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: '你好' },
      { type: 'text-end', id: 'text-1' },
      { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'bash' },
      { type: 'tool-input-delta', toolCallId: 'call-1', inputTextDelta: '{}' },
      { type: 'tool-input-available', toolCallId: 'call-1' },
      { type: 'tool-output-available', toolCallId: 'call-1', output: 'done' },
      { type: '__run_end__' },
    ]
    const state = createAgUiDecodeState()
    const decoded = chunks.flatMap((chunk) =>
      encodeAgUiChunk(chunk, ctx).flatMap((event) => agUiEventToChunks(event, state)),
    )
    expect(decoded).toMatchObject([
      { type: 'start', messageId: 'msg-1' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: '你好' },
      { type: 'text-end', id: 'text-1' },
      { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'bash' },
      { type: 'tool-input-delta', toolCallId: 'call-1', inputTextDelta: '{}' },
      { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'bash', input: {} },
      { type: 'tool-output-available', toolCallId: 'call-1', output: 'done' },
      { type: 'finish' },
    ])
  })
})

describe('形态判别', () => {
  it('isAgUiEvent 认事件、不认 chunk', () => {
    expect(isAgUiEvent({ type: 'RUN_STARTED', threadId: 't', runId: 'r' })).toBe(true)
    expect(isAgUiEvent({ type: 'text-delta', id: 'x' })).toBe(false)
    expect(isAgUiEvent(null)).toBe(false)
  })

  it('isRunFinalEvent 三种形态都认', () => {
    expect(isRunFinalEvent({ type: 'RUN_FINISHED' })).toBe(true)
    expect(isRunFinalEvent({ type: 'finish' })).toBe(true)
    expect(isRunFinalEvent({ type: '__run_end__' })).toBe(true)
    expect(isRunFinalEvent({ type: 'text-delta' })).toBe(false)
  })
})

describe('parseAgUiSse', () => {
  const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`

  it('跨 chunk 缓冲：半截 JSON 不会解析失败', async () => {
    const full =
      ': ping\n\n' +
      frame({ type: 'RUN_STARTED', threadId: 't', runId: 'r' }) +
      frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: '你' }) +
      'data: [DONE]\n\n' +
      frame({ type: 'RUN_FINISHED', threadId: 't', runId: 'r' })
    const bytes = new TextEncoder().encode(full)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 故意切在 JSON 中间
        for (let index = 0; index < bytes.length; index += 7) {
          controller.enqueue(bytes.slice(index, index + 7))
        }
        controller.close()
      },
    })
    const events: unknown[] = []
    for await (const event of parseAgUiSse(stream)) events.push(event)
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_CONTENT',
      'RUN_FINISHED',
    ])
  })

  it('尾帧没有 \\n\\n 也要冲出来', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}'),
        )
        controller.close()
      },
    })
    const events: unknown[] = []
    for await (const event of parseAgUiSse(stream)) events.push(event)
    expect(events).toHaveLength(1)
  })
})
