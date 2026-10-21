/**
 * 会话页的路由口径（**一个会话一个地址**）。
 *
 * 为什么把路径集中在这里：侧栏的列表项、新建按钮、页面里的跳转都要拼同一个地址，
 * 散在各处改一处漏一处（尤其 `new` 这个保留段）。
 */

/** 会话页根路径（侧栏 + 空态 / 重定向用） */
export const CHAT_ROOT = '/main/ai/chat'

/**
 * 「还没建会话」的占位地址段。
 *
 * ⚠️ 这是**保留段**：`[conversationId]` 动态路由下，它不能是一个真实会话 id。
 * 会话 id 由服务端生成（20 位左右的 nanoid 风格字符串），永远不会等于 `new`。
 */
export const NEW_CONVERSATION_SLUG = 'new'

/** 某个会话的地址 */
export const conversationPath = (conversationId: string): string =>
  `${CHAT_ROOT}/${conversationId}`

/** 「新会话」地址（首轮发出后服务端返回会话 id，页面会 `replace` 成真实地址） */
export const newConversationPath = (): string => `${CHAT_ROOT}/${NEW_CONVERSATION_SLUG}`

/** 这个路由参数是不是"还没建会话"的占位 */
export const isNewConversation = (conversationId: string | undefined): boolean =>
  !conversationId || conversationId === NEW_CONVERSATION_SLUG

/**
 * 会话页的"隔离代次"：只有真正换会话时才递增。
 *
 * `new → 真实 id` 是同一次发送的延续，不能递增——递增会让页面 key 变化，
 * 整棵对话区重挂载，正在流的 `useChat` 连接和刚收到的消息一起被掐掉。
 * 其余变化（A→B、A→new）都必须递增，避免把上一个会话的 Chat 状态带过去。
 */
export const nextChatGeneration = (
  previousId: string,
  nextId: string,
  generation: number,
): number => {
  if (previousId === nextId) return generation
  const wasNew = isNewConversation(previousId)
  const nowNew = isNewConversation(nextId)
  return wasNew && !nowNew ? generation : generation + 1
}
