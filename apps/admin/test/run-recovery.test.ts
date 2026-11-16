import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { mergeAssistantMessage } from '../src/app/(app)/(standalone)/main/ai/chat/run-recovery'

/**
 * 恢复结束后的合并顺序（手册 §7.3）。
 *
 * 钉住的是用户可见的那条：同 id **原位替换**，不能"先删再追加到末尾" ——
 * 否则一轮结束后用户发下一条时会看到 `[user1, user2, AI]`。
 */

const message = (id: string, text: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
})

describe('mergeAssistantMessage', () => {
  it('同 id 原位替换，位置不变', () => {
    const messages = [message('u1', '问'), message('a1', '半截'), message('u2', '再问')]
    const merged = mergeAssistantMessage(messages, message('a1', '完整回答'))
    expect(merged.map((item) => item.id)).toEqual(['u1', 'a1', 'u2'])
    expect(merged[1]?.parts).toEqual([{ type: 'text', text: '完整回答' }])
    // 不改入参
    expect(messages[1]?.parts).toEqual([{ type: 'text', text: '半截' }])
  })

  it('没有同 id 才追加到末尾', () => {
    const merged = mergeAssistantMessage([message('u1', '问')], message('a1', '回答'))
    expect(merged.map((item) => item.id)).toEqual(['u1', 'a1'])
  })
})
