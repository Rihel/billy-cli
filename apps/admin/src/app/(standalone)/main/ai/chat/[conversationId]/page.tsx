'use client'

import { use, useMemo, useRef } from 'react'
import { ChatConversation } from '../chat-conversation'
import { nextChatGeneration } from '../routes'

/**
 * 一个会话一个地址：`/main/ai/chat/[conversationId]`。
 *
 * `new` 只是占位地址：首轮发出后服务端从流里回真实会话 id，页面把地址 replace 成真实地址。
 * **这一段不能把 `key` 直接绑到 URL 参数**：`new → 真实 id` 会把整棵对话区重挂载，
 * 正在流的 `useChat` 连接和刚收到的消息都会断掉——用户看到的就是"闪一下 / SSE 断了"。
 *
 * 会话 key 的口径：
 * - `new → 真实 id`：同一次发送，沿用旧 key，组件不重挂载；
 * - `真实 A → 真实 B`：换会话，key 递增，整棵对话区隔离；
 * - `真实 A → new`：新会话，key 递增，不能复用 A 的 useChat 状态。
 */
export default function ChatConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>
}) {
  const { conversationId } = use(params)
  const previousId = useRef(conversationId)
  const generation = useRef(0)

  const sessionKey = useMemo(() => {
    generation.current = nextChatGeneration(
      previousId.current,
      conversationId,
      generation.current,
    )
    previousId.current = conversationId
    return `chat-${generation.current}`
  }, [conversationId])

  return <ChatConversation key={sessionKey} conversationId={conversationId} />
}
