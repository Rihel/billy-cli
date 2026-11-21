import { describe, expect, it } from 'vitest'
import type { ChatMessageState } from '../src/app/(app)/(standalone)/main/ai/chat/chat-session.ts'
import { groupChatTurns } from '../src/app/(app)/(standalone)/main/ai/chat/chat-turns.ts'

/**
 * 按用户消息切轮次：吸顶的包含块就是这一轮，气泡才能「这一轮读到哪里都钉着、下一轮顶走」。
 */
const message = (id: string, role: 'user' | 'assistant'): ChatMessageState =>
  ({ id, role }) as ChatMessageState

describe('groupChatTurns', () => {
  it('一条用户消息 + 后续回答算一轮；下一条用户消息开新轮', () => {
    const turns = groupChatTurns([
      message('u1', 'user'),
      message('a1', 'assistant'),
      message('a2', 'assistant'),
      message('u2', 'user'),
      message('a3', 'assistant'),
    ])

    expect(turns.map((turn) => turn.key)).toEqual(['u1', 'u2'])
    expect(turns[0]?.messages.map((item) => item.id)).toEqual(['u1', 'a1', 'a2'])
    expect(turns[1]?.messages.map((item) => item.id)).toEqual(['u2', 'a3'])
  })

  it('连续两条用户消息各成一轮（第一条没有回答，也不会被吞进下一轮）', () => {
    const turns = groupChatTurns([message('u1', 'user'), message('u2', 'user')])

    expect(turns.map((turn) => turn.key)).toEqual(['u1', 'u2'])
    expect(turns.every((turn) => turn.messages.length === 1)).toBe(true)
  })

  it('历史里前置的助手消息自成一组（不产生吸顶气泡）', () => {
    const turns = groupChatTurns([message('a0', 'assistant'), message('u1', 'user')])

    expect(turns.map((turn) => turn.key)).toEqual(['a0', 'u1'])
    expect(turns[0]?.messages.map((item) => item.id)).toEqual(['a0'])
  })

  it('空列表不造出空轮次', () => {
    expect(groupChatTurns([])).toEqual([])
  })
})
