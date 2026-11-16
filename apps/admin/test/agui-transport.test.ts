import { describe, expect, it } from 'vitest'
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import {
  agUiSseToChunkStream,
  markTransientChunks,
  TRANSIENT_DATA_CHUNK_TYPES,
} from '../src/app/(app)/(standalone)/main/ai/chat/chat-transport'

/**
 * 传输层适配：AG-UI SSE → AI SDK chunk。
 *
 * 这是前端**唯一**的协议适配点。钉住三件事：
 * 1. 事件名映射对（文本 / 工具 / 业务 CUSTOM / 收尾）；
 * 2. 工具入参靠 ARGS 累积成完整 input（不累积就永远渲染不出入参）；
 * 3. 逐帧增量仍被标成 transient（不落 part，否则长会话卡死）。
 */

const sse = (events: unknown[]): ReadableStream<Uint8Array> => {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  const bytes = new TextEncoder().encode(body)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // 故意切碎，验证跨 chunk 缓冲
      for (let index = 0; index < bytes.length; index += 11) {
        controller.enqueue(bytes.slice(index, index + 11))
      }
      controller.close()
    },
  })
}

const collect = async (stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> => {
  const reader = stream.getReader()
  const chunks: UIMessageChunk[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return chunks
    if (value) chunks.push(value)
  }
}

describe('agUiSseToChunkStream', () => {
  it('文本 / 业务 CUSTOM / 收尾都映射成 useChat 认识的 chunk', async () => {
    const chunks = await collect(
      agUiSseToChunkStream(
        sse([
          { type: 'RUN_STARTED', threadId: 'conv-1', runId: 'run-1' },
          { type: 'CUSTOM', name: 'agent.message', value: { messageId: 'msg-1' } },
          { type: 'TEXT_MESSAGE_START', messageId: 'text-1' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'text-1', delta: '你' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'text-1', delta: '好' },
          { type: 'TEXT_MESSAGE_END', messageId: 'text-1' },
          { type: 'CUSTOM', name: 'agent.plan', value: { tasks: [] } },
          { type: 'RUN_FINISHED', threadId: 'conv-1', runId: 'run-1' },
        ]),
      ),
    )

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'data-run',
      'start',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'data-plan',
      'finish',
    ])
    expect(chunks[0]).toMatchObject({ data: { runId: 'run-1', conversationId: 'conv-1' } })
    expect(chunks[1]).toEqual({ type: 'start', messageId: 'msg-1' })
  })

  it('工具链：ARGS 累积到 END 时给完整 input，结果单独一块', async () => {
    const chunks = await collect(
      agUiSseToChunkStream(
        sse([
          { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'bash' },
          { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"command":' },
          { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '"ls"}' },
          { type: 'TOOL_CALL_END', toolCallId: 'c1' },
          { type: 'TOOL_CALL_RESULT', messageId: 'm', toolCallId: 'c1', content: '{"ok":true}' },
        ]),
      ),
    )

    expect(chunks.find((chunk) => chunk.type === 'tool-input-available')).toMatchObject({
      toolCallId: 'c1',
      toolName: 'bash',
      input: { command: 'ls' },
    })
    expect(chunks.find((chunk) => chunk.type === 'tool-output-available')).toMatchObject({
      toolCallId: 'c1',
      output: { ok: true },
    })
  })

  it('子助手增量仍标 transient（不落 part）', async () => {
    const stream = markTransientChunks(
      agUiSseToChunkStream(
        sse([
          {
            type: 'CUSTOM',
            name: 'agent.sub-agent',
            value: { kind: 'data-sub-agent-delta', data: { delta: '过程' } },
          },
        ]),
      ),
    )
    const chunks = await collect(stream)
    expect(chunks[0]).toMatchObject({ type: 'data-sub-agent-delta', transient: true })
    expect(TRANSIENT_DATA_CHUNK_TYPES.has('data-sub-agent-delta')).toBe(true)
  })

  it('恢复流：快照种子 + sinceRev 增量，same-id start 不会重置种子', async () => {
    const seed: UIMessage = {
      id: 'msg-1',
      role: 'assistant',
      parts: [{ type: 'text', text: '快照里的已闭合正文' }],
    }
    const messages: UIMessage[] = []
    for await (const message of readUIMessageStream({
      message: seed,
      stream: agUiSseToChunkStream(
        sse([
          { type: 'RUN_STARTED', threadId: 'conv-1', runId: 'run-1' },
          { type: 'CUSTOM', name: 'agent.message', value: { messageId: 'msg-1' } },
          { type: 'TEXT_MESSAGE_START', messageId: 'open-1' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'open-1', delta: '还在流的部分' },
          { type: 'TEXT_MESSAGE_END', messageId: 'open-1' },
        ]),
      ),
    })) {
      messages.push(message)
    }

    const final = messages.at(-1)!
    expect(final.id).toBe('msg-1')
    // 种子正文保留，增量追加在后（中间允许有 `data-run` part）
    expect(final.parts.filter((part) => part.type === 'text').map((part) => part.text)).toEqual([
      '快照里的已闭合正文',
      '还在流的部分',
    ])
  })

  it('RUN_ERROR 变成 error chunk（useChat 的 onError 能拿到原因）', async () => {
    const chunks = await collect(
      agUiSseToChunkStream(sse([{ type: 'RUN_ERROR', message: '模型挂了' }])),
    )
    expect(chunks).toEqual([{ type: 'error', errorText: '模型挂了' }])
  })
})
