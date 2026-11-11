'use client'

import { createContext, useContext } from 'react'

/**
 * 会话页手机端导航：布局持有会话列表 Sheet，页头按钮只需要一个"打开"入口。
 * 放在单独模块里，避免页头组件反过来 import layout 造成循环。
 */
export interface ChatMobileNav {
  openConversations: () => void
}

export const ChatMobileNavContext = createContext<ChatMobileNav | null>(null)

export const useChatMobileNav = (): ChatMobileNav | null => useContext(ChatMobileNavContext)
