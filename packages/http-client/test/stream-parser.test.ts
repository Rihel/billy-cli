import { describe, expect, it } from 'vitest'
import { StreamParser } from '../src/index.js'
import type { StreamMessage } from '../src/index.js'

const collect = () => {
  const messages: StreamMessage[] = []
  const parser = new StreamParser({ onMessage: (m) => messages.push(m) })
  return { parser, messages }
}

describe('StreamParser 帧解析', () => {
  it('解析单条完整消息（event / data / id / retry）', () => {
    const { parser, messages } = collect()
    parser.push('id: 1\nevent: progress\ndata: {"percent":50}\nretry: 5000\n\n')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual({
      id: '1',
      event: 'progress',
      data: '{"percent":50}',
      retry: 5000,
    })
  })

  it('连续解析多条消息', () => {
    const { parser, messages } = collect()
    parser.push('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n')
    expect(messages.map((m) => m.event)).toEqual(['a', 'b'])
    expect(messages.map((m) => m.data)).toEqual(['1', '2'])
  })

  it('data 多行以 \\n 拼接', () => {
    const { parser, messages } = collect()
    parser.push('data: line1\ndata: line2\ndata: line3\n\n')
    expect(messages[0].data).toBe('line1\nline2\nline3')
  })

  it('注释行（: 开头）忽略', () => {
    const { parser, messages } = collect()
    parser.push(': keep-alive\n: heartbeat\nevent: e\ndata: 1\n\n')
    expect(messages).toHaveLength(1)
    expect(messages[0].event).toBe('e')
  })

  it('空事件名按 message 处理', () => {
    const { parser, messages } = collect()
    parser.push('data: hello\n\n')
    expect(messages[0].event).toBe('message')
  })

  it('无 data 的空消息不派发', () => {
    const { parser, messages } = collect()
    parser.push('event: empty\n\n')
    expect(messages).toHaveLength(0)
  })

  it('冒号后的第一个空格被忽略（仅一个）', () => {
    const { parser, messages } = collect()
    parser.push('data: hello\n\n')
    expect(messages[0].data).toBe('hello')
    parser.push('data:  hello\n\n')
    expect(messages[1].data).toBe(' hello')
  })

  it('无冒号字段行视为空值', () => {
    const { parser, messages } = collect()
    parser.push('event\ndata: x\n\n')
    expect(messages[0].event).toBe('message')
  })

  it('未知字段忽略（向后兼容）', () => {
    const { parser, messages } = collect()
    parser.push('foo: bar\ndata: x\n\n')
    expect(messages).toHaveLength(1)
    expect(messages[0].data).toBe('x')
  })

  it('retry 持久生效并触发 onRetry 回调', () => {
    const retries: number[] = []
    const messages: StreamMessage[] = []
    const parser = new StreamParser({
      onMessage: (m) => messages.push(m),
      onRetry: (r) => retries.push(r),
    })
    parser.push('retry: 2000\nevent: a\ndata: 1\n\n')
    parser.push('event: b\ndata: 2\n\n')
    expect(retries).toEqual([2000])
    // retry 持久：后续消息仍携带当前值
    expect(messages[0].retry).toBe(2000)
    expect(messages[1].retry).toBe(2000)
  })

  it('跨 chunk 边界正确拼接（消息被拆成两半）', () => {
    const { parser, messages } = collect()
    parser.push('event: partial')
    parser.push('\ndata: {"x":1}\n\n')
    expect(messages).toHaveLength(1)
    expect(messages[0].event).toBe('partial')
    expect(messages[0].data).toBe('{"x":1}')
  })

  it('支持 \\r\\n 行分隔', () => {
    const { parser, messages } = collect()
    parser.push('event: e\r\ndata: 1\r\n\r\n')
    expect(messages[0].data).toBe('1')
  })

  it('flush 清空残余缓冲且不派发', () => {
    const { parser, messages } = collect()
    parser.push('event: orphan\ndata: 1')
    parser.flush()
    expect(messages).toHaveLength(0)
  })
})
