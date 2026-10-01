'use client'

import { use } from 'react'
import { ChatConversation } from '../chat-conversation'

/**
 * 一个会话一个地址：`/main/ai/chat/[conversationId]`。
 *
 * `conversationId` 为保留段 `new` 时表示"还没建会话"：首轮发出后服务端从流里回真实会话 id，
 * 页面把地址 `replace` 成真实地址（同一动态路由换参数，**不重挂载**，正在流的这一轮不中断）。
 *
 * ⚠️ key 用会话 id：切换会话时**整棵对话区重挂载** —— `useChat` 的内部消息、reasoning 面板的
 * 展开状态、子助手面板的增量缓存全部跟着隔离，不会串会话。
 */
export default function ChatConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>
}) {
  const { conversationId } = use(params)
  return <ChatConversation key={conversationId} conversationId={conversationId} />
}
