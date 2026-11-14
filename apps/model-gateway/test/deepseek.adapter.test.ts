import { describe, expect, it } from 'vitest'
import { withDeepSeekReasoning } from '../src/protocols/deepseek.adapter.js'

const body = (extra: Record<string, unknown> = {}) => ({
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: 'ok', reasoning_content: '已有的思考' },
  ],
  ...extra,
})

describe('DeepSeek 适配器：reasoning_content 回放', () => {
  it('未开 thinking 且不是 reasoner：原样透传', () => {
    const input = body()
    expect(withDeepSeekReasoning(input, 'deepseek-chat')).toBe(input)
  })

  it('开了 thinking：assistant 历史补空串，已有值保留', () => {
    const out = withDeepSeekReasoning(body({ thinking: { type: 'enabled' } }), 'deepseek-chat')
    const messages = out.messages as Record<string, unknown>[]
    expect(messages[1].reasoning_content).toBe('')
    expect(messages[3].reasoning_content).toBe('已有的思考')
    expect(messages[0]).not.toHaveProperty('reasoning_content')
  })

  it('reasoner 模型同样补空串', () => {
    const out = withDeepSeekReasoning(body(), 'deepseek-reasoner')
    expect((out.messages as Record<string, unknown>[])[1].reasoning_content).toBe('')
  })
})
