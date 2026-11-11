'use client'

import { use, useRef } from 'react'
import { ChatConversation } from '../chat-conversation'
import { ChatSessionStore, ChatSessionStoreContext } from '../chat-session'
import { chatSessionKey } from '../routes'

/**
 * 会话 store 的**归属层**：建在会话页外面，供整棵子树读 context。
 *
 * 为什么必须在这里（踩过，SSR 直接炸）：store 的 Provider 不能由**使用它的人自己**渲染 ——
 * `ChatConversation` 在组件体里 `useContext` 时，它 `return` 的 Provider 还没挂上，
 * 读到的永远是 null（SSR 报"会话 store 缺失"、客户端整页退化为客户端渲染，页面因此错位出空白）。
 * 所以 store 建在这里，`Collapsible` 换成 key：换会话就重挂载、store 跟着换。
 */
function ChatSessionProvider({ children }: { children: React.ReactNode }) {
  const storeRef = useRef<ChatSessionStore | null>(null)
  if (!storeRef.current) storeRef.current = new ChatSessionStore()
  return (
    <ChatSessionStoreContext.Provider value={storeRef.current}>
      {children}
    </ChatSessionStoreContext.Provider>
  )
}

/**
 * 一个会话一个地址：`/main/ai/chat/[conversationId]`。
 *
 * `new` 只是占位地址：首轮发出后服务端从流里回真实会话 id，页面把地址 replace 成真实地址。
 * **这一段不能把 `key` 直接绑到 URL 参数**：`new → 真实 id` 会把整棵对话区重挂载，
 * 正在流的 `useChat` 连接和刚收到的消息都会断掉——用户看到的就是"闪一下 / SSE 断了"。
 *
 * 会话 key 由 `routes.ts` 的 `chatSessionKey` 统一给：
 * - 真实会话按 id 隔离，页面组件重挂载也不会复用旧 store；
 * - `new → 真实 id` 同一次发送，映射到同一个 new key，不重挂载；
 * - 下一次 new / 换真实会话都拿到新 key。
 */
export default function ChatConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>
}) {
  const { conversationId } = use(params)

  return (
    <ChatSessionProvider key={chatSessionKey(conversationId)}>
      <ChatConversation conversationId={conversationId} />
    </ChatSessionProvider>
  )
}
