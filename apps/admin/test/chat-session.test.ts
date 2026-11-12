import { describe, expect, it } from 'vitest'
import {
  chatSessionKey,
  isNewConversation,
  markAdoptedConversation,
  nextChatGeneration,
} from '../src/app/(app)/(standalone)/main/ai/chat/routes'

describe('会话页隔离代次', () => {
  it('new → 真实 id 不递增：首轮流不能被重挂载打断', () => {
    expect(nextChatGeneration('new', 'conv_a', 0)).toBe(0)
  })

  it('真实 A → 真实 B 递增：不同会话不能串状态', () => {
    expect(nextChatGeneration('conv_a', 'conv_b', 0)).toBe(1)
  })

  it('真实 → new 递增：新会话不能复用旧 Chat', () => {
    expect(nextChatGeneration('conv_a', 'new', 0)).toBe(1)
  })

  it('new → new 不递增：仍是同一个未建会话', () => {
    expect(nextChatGeneration('new', 'new', 0)).toBe(0)
  })

  it('保留段判断', () => {
    expect(isNewConversation('new')).toBe(true)
    expect(isNewConversation(undefined)).toBe(true)
    expect(isNewConversation('conv_a')).toBe(false)
  })
})

describe('会话页 store key 隔离', () => {
  it('不同真实会话必须得到不同 key，页面重挂载也不会复用旧 store', () => {
    const a = chatSessionKey('conv_iso_a')
    const b = chatSessionKey('conv_iso_b')
    expect(a).toBe('chat-conv_iso_a')
    expect(b).toBe('chat-conv_iso_b')
    expect(a).not.toBe(b)
    // 重复读取稳定，不能每次渲染换 key
    expect(chatSessionKey('conv_iso_a')).toBe(a)
  })

  it('new → 真实 id 沿用同一个 key；下一次 new 换新 key', () => {
    const newKey = chatSessionKey('new')
    markAdoptedConversation('conv_iso_adopted')
    expect(chatSessionKey('conv_iso_adopted')).toBe(newKey)
    const nextNewKey = chatSessionKey('new')
    expect(nextNewKey).not.toBe(newKey)
  })
})
