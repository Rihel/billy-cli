import { EventEmitter } from 'node:events'
import type { Response } from 'express'
import { describe, expect, it } from 'vitest'
import {
  AnthropicAdapter,
  anthropicResponseToOpenai,
  relayAnthropicStream,
  toAnthropicBody,
} from '../src/protocols/anthropic.adapter.js'
import { entryOf, targetOf } from './helpers.js'

const target = targetOf({
  entry: entryOf({
    providerKind: 'anthropic',
    protocol: 'anthropic',
    providerSlug: 'claude',
    providerName: 'Anthropic',
    modelKey: 'claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
  }),
  apiKey: 'sk-ant-test',
  baseUrl: 'https://api.anthropic.com',
})

const adapter = new AnthropicAdapter()

const options = {
  model: target.entry,
  abort: (): void => {},
  idleTimeoutMs: 5_000,
}

const jsonContext = { id: 'chatcmpl-test', created: 1, model: 'claude-sonnet-4-5' }

const sseFrame = (type: string, payload: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`

const streamOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })

const streamOfParts = (parts: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
      controller.close()
    },
  })

class FakeResponse extends EventEmitter {
  writableEnded = false
  frames: string[] = []

  write(chunk: string): boolean {
    this.frames.push(chunk)
    return true
  }

  end(): void {
    this.writableEnded = true
  }
}

const asResponse = (res: FakeResponse): Response => res as unknown as Response

describe('Anthropic 请求转换', () => {
  it('拼出 {base}/v1/messages，注入 x-api-key，并转换 system/messages/图片/工具', () => {
    const request = adapter.buildRequest({
      body: {
        messages: [
          { role: 'system', content: '规则一' },
          { role: 'system', content: [{ type: 'text', text: '规则二' }] },
          {
            role: 'user',
            content: [
              { type: 'text', text: '看图' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
              { type: 'image_url', image_url: 'https://example.com/a.png' },
            ],
          },
          {
            role: 'assistant',
            content: '我查一下',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'search', arguments: '{"q":"天气"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '晴' },
        ],
        temperature: 0.3,
        top_p: 0.9,
        stop: ['\n\n'],
        stream: true,
        tools: [
          {
            type: 'function',
            function: {
              name: 'search',
              description: '搜索',
              parameters: { type: 'object', properties: { q: { type: 'string' } } },
            },
          },
        ],
        tool_choice: 'auto',
        reasoning_effort: 'high',
      },
      target,
    })

    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
    expect(request.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    })

    const out = request.body as Record<string, unknown>
    expect(out).toMatchObject({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: '规则一\n\n规则二',
      stream: true,
      temperature: 0.3,
      top_p: 0.9,
      stop_sequences: ['\n\n'],
      tool_choice: { type: 'auto' },
      thinking: { type: 'enabled', budget_tokens: 1024 },
    })
    expect(out.tools).toEqual([
      {
        name: 'search',
        description: '搜索',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ])

    const messages = out.messages as Record<string, unknown>[]
    expect(messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
        },
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      ],
    })
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: '我查一下' },
        { type: 'tool_use', id: 'call_1', name: 'search', input: { q: '天气' } },
      ],
    })
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '晴' }],
    })
  })

  it('max_tokens 显式传入；坏 JSON 参数用 {}；function tool_choice 映射为 tool', () => {
    const out = toAnthropicBody(
      {
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_9', type: 'function', function: { name: 'search', arguments: '{坏' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_9', content: '结果' },
        ],
        max_tokens: 256,
        tool_choice: { type: 'function', function: { name: 'search' } },
      },
      'claude-sonnet-4-5',
    )

    expect(out.max_tokens).toBe(256)
    expect(out.tool_choice).toEqual({ type: 'tool', name: 'search' })
    expect(out.thinking).toBeUndefined()
    const messages = out.messages as Record<string, unknown>[]
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_9', name: 'search', input: {} }],
    })
  })
})

describe('Anthropic 非流式响应', () => {
  it('text / thinking / tool_use / usage 都能翻译回 OpenAI 形态', () => {
    const out = adapter.translateJson(
      {
        id: 'msg_123',
        content: [
          { type: 'thinking', thinking: '先想' },
          { type: 'text', text: '答案' },
          { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: '天气' } },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
        },
      },
      target,
    ) as Record<string, unknown>

    expect(out).toMatchObject({
      id: 'msg_123',
      object: 'chat.completion',
      model: 'claude-sonnet-4-5',
      created: expect.any(Number),
    })
    const choice = (out.choices as Record<string, unknown>[])[0]
    expect(choice).toEqual({
      index: 0,
      message: {
        role: 'assistant',
        content: '答案',
        reasoning_content: '先想',
        tool_calls: [
          {
            index: 0,
            id: 'toolu_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"天气"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    })
    expect(out.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
    })
  })

  it('usage 缺失字段保持 null，不编造 0', () => {
    const out = anthropicResponseToOpenai(
      {
        id: 'msg_u',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5 },
      },
      jsonContext,
    )
    expect(out.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: null,
      total_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    })
  })

  it('stop_reason 映射：end_turn → stop，max_tokens → length', () => {
    const finishOf = (stopReason: string): unknown => {
      const out = anthropicResponseToOpenai(
        {
          id: 'msg_x',
          content: [{ type: 'text', text: 'x' }],
          stop_reason: stopReason,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        jsonContext,
      )
      return (out.choices as Record<string, unknown>[])[0].finish_reason
    }
    expect(finishOf('end_turn')).toBe('stop')
    expect(finishOf('max_tokens')).toBe('length')
    expect(finishOf('tool_use')).toBe('tool_calls')
  })
})

describe('Anthropic 流式事件转换', () => {
  const sse = [
    sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_test',
        role: 'assistant',
        usage: {
          input_tokens: 25,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 3,
          output_tokens: 1,
        },
      },
    }),
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '先想' },
    }),
    sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '你好' },
    }),
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} },
    }),
    sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"q":' },
    }),
    sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '"x"}' },
    }),
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sseFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 15 },
    }),
    sseFrame('message_stop', { type: 'message_stop' }),
  ].join('')

  it('message_start → thinking/text → tool input → message_delta → [DONE]', async () => {
    const res = new FakeResponse()
    // 拆成多段喂入，覆盖跨 chunk 的行缓冲
    const usage = await relayAnthropicStream(
      streamOfParts([sse.slice(0, 120), sse.slice(120, 400), sse.slice(400)]),
      asResponse(res),
      options,
    )

    const frames = res.frames.join('').split('\n\n').filter(Boolean)
    expect(frames.at(-1)).toBe('data: [DONE]')
    const chunks = frames
      .slice(0, -1)
      .map((frame) => JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>)

    expect(chunks.every((chunk) => chunk.id === 'msg_test')).toBe(true)
    const deltaOf = (chunk: Record<string, unknown>): Record<string, unknown> =>
      (chunk.choices as Record<string, unknown>[])[0].delta as Record<string, unknown>

    expect(deltaOf(chunks[0])).toEqual({ role: 'assistant' })
    const deltas = chunks.map(deltaOf)
    expect(deltas).toContainEqual({ reasoning_content: '先想' })
    expect(deltas).toContainEqual({ content: '你好' })

    const toolDeltas = deltas.filter((delta) => Array.isArray(delta.tool_calls))
    expect(toolDeltas).toHaveLength(3)
    expect(toolDeltas[0].tool_calls).toEqual([
      { index: 1, id: 'toolu_1', type: 'function', function: { name: 'search', arguments: '' } },
    ])
    const argumentsOf = toolDeltas
      .slice(1)
      .map((delta) => (delta.tool_calls as Record<string, unknown>[])[0])
      .map((call) => (call.function as Record<string, unknown>).arguments)
      .join('')
    expect(argumentsOf).toBe('{"q":"x"}')

    const last = chunks.at(-1) as Record<string, unknown>
    expect((last.choices as Record<string, unknown>[])[0].finish_reason).toBe('tool_calls')
    expect(last.usage).toEqual({
      prompt_tokens: 25,
      completion_tokens: 15,
      total_tokens: 40,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 3,
    })
    expect(usage).toEqual(last.usage)
    expect(res.writableEnded).toBe(true)
  })

  it('类 relayStream 按接口返回 void，但同样补 [DONE]', async () => {
    const res = new FakeResponse()
    const result = await adapter.relayStream(
      streamOf(
        sseFrame('message_start', {
          type: 'message_start',
          message: { id: 'msg_void', usage: { input_tokens: 2, output_tokens: 1 } },
        }) + sseFrame('message_stop', { type: 'message_stop' }),
      ),
      asResponse(res),
      options,
    )
    expect(result).toBeUndefined()
    expect(res.frames.join('')).toContain('data: [DONE]\n\n')
    expect(res.writableEnded).toBe(true)
  })

  it('没有 usage 事件时返回 null', async () => {
    const res = new FakeResponse()
    const usage = await relayAnthropicStream(
      streamOf(sseFrame('message_stop', { type: 'message_stop' })),
      asResponse(res),
      options,
    )
    expect(usage).toBeNull()
  })

  it('背压：write 返回 false 时等 drain 再继续', async () => {
    class SlowResponse extends FakeResponse {
      private blocked = true

      override write(chunk: string): boolean {
        super.write(chunk)
        if (!this.blocked) return true
        this.blocked = false
        setTimeout(() => this.emit('drain'), 0)
        return false
      }
    }
    const res = new SlowResponse()
    const usage = await relayAnthropicStream(
      streamOf(
        sseFrame('message_start', {
          type: 'message_start',
          message: { id: 'msg_slow', usage: { input_tokens: 3, output_tokens: 1 } },
        }) +
          sseFrame('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 7 },
          }) +
          sseFrame('message_stop', { type: 'message_stop' }),
      ),
      asResponse(res),
      options,
    )
    expect(res.frames.join('')).toContain('data: [DONE]\n\n')
    expect(usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 })
  })
})
