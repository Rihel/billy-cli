import { describe, expect, it } from 'vitest'
import type { TimelineEntity } from '../src/database/entities/timeline-entity.js'
import {
  REHYDRATE_MAX_MESSAGES,
  toRehydrateMessages,
} from '../src/modules/ai/memory/memory.rehydrate.js'

/** 续跑回灌：只回文本，把时间线变成 Mastra 认的消息形状 */
let seq = 0
const event = (partial: Partial<TimelineEntity>): TimelineEntity =>
  ({
    seq: ++seq,
    conversationId: 'conv-1',
    role: 'assistant',
    kind: 'text',
    payload: {},
    ...partial,
  }) as TimelineEntity

describe('toRehydrateMessages', () => {
  it('只取用户 / 助手的文本；推理、工具、系统消息都不回灌', () => {
    seq = 0
    const messages = toRehydrateMessages(
      [
        event({ role: 'user', kind: 'text', payload: { text: '第一问' } }),
        event({ role: 'assistant', kind: 'reasoning', payload: { text: '想一想' } }),
        event({ role: 'assistant', kind: 'text', payload: { text: '第一答' } }),
        event({ role: 'system', kind: 'system', payload: { text: '系统提示词' } }),
        event({ role: 'assistant', kind: 'tool-call', payload: { input: { a: 1 } } }),
        event({ role: 'user', kind: 'text', payload: { text: '第二问' } }),
      ],
      'conv-1',
      'user-1',
    )

    expect(messages.map((message) => message.content.parts[0]?.text)).toEqual([
      '第一问',
      '第一答',
      '第二问',
    ])
    expect(messages.every((message) => message.threadId === 'conv-1')).toBe(true)
    expect(messages.every((message) => message.resourceId === 'user-1')).toBe(true)
    expect(messages[0]?.role).toBe('user')
    expect(messages[1]?.role).toBe('assistant')
  })

  it('最多回灌最近 20 条', () => {
    seq = 0
    const events = Array.from({ length: 25 }, (_, index) =>
      event({ role: 'user', kind: 'text', payload: { text: `第 ${index + 1} 问` } }),
    )

    const messages = toRehydrateMessages(events, 'conv-1', 'user-1')

    expect(messages).toHaveLength(REHYDRATE_MAX_MESSAGES)
    expect(messages.at(-1)?.content.parts[0]?.text).toBe('第 25 问')
  })

  it('空 payload 跳过，不产生空消息', () => {
    const messages = toRehydrateMessages(
      [event({ role: 'user', kind: 'text', payload: {} })],
      'conv-1',
      'user-1',
    )
    expect(messages).toEqual([])
  })
})
