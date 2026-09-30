import { redirect } from 'next/navigation'
import { newConversationPath } from './routes'

/**
 * `/main/ai/chat`（会话页根路径）→ 直接进「新会话」地址。
 *
 * 为什么不在这里渲染一个"空对话区"：地址是状态的载体（需求：每个对话一个路由），
 * 根路径没有会话身份，渲染它就会出现"两个地址显示同一件事"的含混状态。
 * 重定向到 `/main/ai/chat/new` 后，任何时刻 URL 都唯一对应一个会话（或"新会话"）。
 */
export default function ChatIndexPage() {
  redirect(newConversationPath())
}
