import type { ChatMessageState } from './chat-session'

/** 一轮：一条用户消息 + 它后面、下一条用户消息之前的全部消息（回答 / 工具 / 子助手都在里面） */
export interface ChatTurn {
  /** 轮次键：用该轮用户消息的 id（没有用户消息时用首条消息的 id） */
  key: string
  messages: ChatMessageState[]
}

/**
 * 按「用户消息」切轮次：用户气泡是这一轮的标题，滚动时钉在列顶部。
 *
 * 为什么必须分组、而不是给每条用户消息单独加 `sticky`：`position: sticky` 只能在自己的
 * **包含块**里移动。把用户消息和它的回答放进同一个轮次容器，气泡就会「这一轮读到哪里都钉着」；
 * 下一轮的气泡到达顶部时，把上一轮的气泡顶走 —— 正好是「视口之前最近的那个气泡吸顶」。
 *
 * 历史异常兜底：第一条消息不是用户消息时，这批前置消息自成一组（不产生吸顶气泡）。
 */
export const groupChatTurns = (messages: readonly ChatMessageState[]): ChatTurn[] => {
  const turns: ChatTurn[] = []
  for (const message of messages) {
    const current = turns[turns.length - 1]
    if (message.role === 'user' || !current) {
      turns.push({ key: message.id, messages: [message] })
      continue
    }
    current.messages.push(message)
  }
  return turns
}
