import { describe, expect, it } from 'vitest'
import {
  ollamaChunkToOpenai,
  ollamaResponseToOpenai,
  toOllamaBody,
} from '../src/protocols/ollama.adapter.js'

const ctx = { id: 'chatcmpl-test', created: 1, model: 'qwen3.8:27b' }

describe('Ollama 协议翻译', () => {
  it('请求：parts → content + images(base64)，并映射 options', () => {
    const out = toOllamaBody(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '看图' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
            ],
          },
        ],
        stream: true,
        temperature: 0.3,
        max_tokens: 128,
        response_format: { type: 'json_object' },
      },
      'qwen3.8:27b',
    )
    expect(out.model).toBe('qwen3.8:27b')
    expect(out.stream).toBe(true)
    expect(out.format).toBe('json')
    const messages = out.messages as Record<string, unknown>[]
    expect(messages[0].content).toBe('看图')
    expect(messages[0].images).toEqual(['QUJD'])
    expect(out.options).toMatchObject({ temperature: 0.3, num_predict: 128 })
  })

  it('流式行：content / thinking / tool_calls / done usage', () => {
    const content = ollamaChunkToOpenai(
      { message: { role: 'assistant', content: '你' }, done: false },
      ctx,
    ) as Record<string, unknown>
    expect((content.choices as any)[0].delta.content).toBe('你')

    const thinking = ollamaChunkToOpenai(
      { message: { role: 'assistant', content: '', thinking: '想' }, done: false },
      ctx,
    ) as Record<string, unknown>
    expect((thinking.choices as any)[0].delta.reasoning_content).toBe('想')

    const tools = ollamaChunkToOpenai(
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'search', arguments: { q: 'x' } } }],
        },
        done: false,
      },
      ctx,
    ) as Record<string, unknown>
    const delta = (tools.choices as any)[0].delta
    expect(delta.tool_calls[0]).toMatchObject({
      index: 0,
      type: 'function',
      function: { name: 'search', arguments: '{"q":"x"}' },
    })

    const done = ollamaChunkToOpenai(
      { done: true, done_reason: 'length', prompt_eval_count: 10, eval_count: 5 },
      ctx,
    ) as Record<string, unknown>
    expect((done.choices as any)[0].finish_reason).toBe('length')
    expect(done.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  })

  it('非流式响应 → OpenAI 响应', () => {
    const out = ollamaResponseToOpenai(
      {
        message: { role: 'assistant', content: '你好', thinking: '思考' },
        done: true,
        prompt_eval_count: 3,
        eval_count: 2,
      },
      ctx,
    ) as Record<string, unknown>
    const choice = (out.choices as any)[0]
    expect(choice.message.content).toBe('你好')
    expect(choice.message.reasoning_content).toBe('思考')
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })
  })
})
