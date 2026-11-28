import { describe, expect, it } from 'vitest'
import { MastraModelClient } from '../src/modules/ai/engine/adapters/model-client.adapter.js'
import type { ModelEvent } from '../src/modules/ai/engine/model-client.js'

const collect = async (events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> => {
  const list: ModelEvent[] = []
  for await (const event of events) list.push(event)
  return list
}

const fakeInstance = (chunks: unknown[]) => ({
  doStream: async () => ({
    stream: (async function* () {
      for (const chunk of chunks) yield chunk
    })(),
  }),
})

describe('MastraModelClient', () => {
  it('把 AI SDK 的 chunk 映射成 Loop 的模型事件', async () => {
    const client = new MastraModelClient(
      'deepseek/deepseek-chat',
      64_000,
      fakeInstance([
        { type: 'reasoning', textDelta: '想一下' },
        { type: 'text-delta', textDelta: '你' },
        { type: 'text-delta', textDelta: '好' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'read-file', args: '{"path":"a"}' },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 4 },
        },
      ]),
    )

    expect(client.ref).toBe('deepseek/deepseek-chat')
    expect(client.contextWindow).toBe(64_000)

    const events = await collect(client.stream({ messages: [{ role: 'user', content: '你好' }] }))
    expect(events).toEqual([
      { type: 'reasoning', delta: '想一下' },
      { type: 'text', delta: '你' },
      { type: 'text', delta: '好' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'read-file', input: { path: 'a' } },
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 4 },
      },
      { type: 'finish', reason: 'tool-calls' },
    ])
  })

  it('工具入参不是 JSON 时原样保留，不中断流', async () => {
    const client = new MastraModelClient(
      'p/m',
      null,
      fakeInstance([{ type: 'tool-call', toolCallId: 'c', toolName: 't', args: '半截' }]),
    )
    const events = await collect(client.stream({ messages: [] }))
    expect(events[0]).toEqual({
      type: 'tool-call',
      toolCallId: 'c',
      toolName: 't',
      input: '半截',
    })
  })

  it('实例不支持 doStream 时给出可排查的错误', async () => {
    const client = new MastraModelClient('p/m', null, {})
    await expect(collect(client.stream({ messages: [] }))).rejects.toThrow('不支持 doStream')
  })
})
