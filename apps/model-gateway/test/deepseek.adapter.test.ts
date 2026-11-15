import { describe, expect, it } from 'vitest'
import { withDeepSeekReasoning } from '../src/protocols/deepseek.adapter.js'

const tools = [
  {
    type: 'function',
    function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
  },
]

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
  it('请求不带 tools：原样透传（上游忽略该字段，不会报错）', () => {
    const input = body()
    expect(withDeepSeekReasoning(input)).toBe(input)
  })

  it('tools 是空数组：等价于没带工具，同样透传', () => {
    const input = body({ tools: [] })
    expect(withDeepSeekReasoning(input)).toBe(input)
  })

  it('带 tools：assistant 历史补空串，已有值保留，非 assistant 不加', () => {
    const out = withDeepSeekReasoning(body({ tools }))
    const messages = out.messages as Record<string, unknown>[]
    expect(messages[1].reasoning_content).toBe('')
    expect(messages[3].reasoning_content).toBe('已有的思考')
    expect(messages[0]).not.toHaveProperty('reasoning_content')
    expect(messages[2]).not.toHaveProperty('reasoning_content')
  })

  it('工具调用续跑（assistant 带 tool_calls + 以 tool 结果收尾）：也必须补空串', () => {
    const input = body({
      tools,
      messages: [
        { role: 'user', content: '北京天气怎么样？' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '晴，26 度' },
      ],
    })
    const out = withDeepSeekReasoning(input)
    const messages = out.messages as Record<string, unknown>[]
    expect(messages[1].reasoning_content).toBe('')
    expect(messages[2]).not.toHaveProperty('reasoning_content')
  })

  it('带 tools 但 messages 不是数组：原样返回，不抛错', () => {
    const input = { tools, messages: null } as Record<string, unknown>
    expect(withDeepSeekReasoning(input)).toBe(input)
  })
})
