import type { ConversationEntity } from '@repo/db'
import type { AppLogger } from '@repo/kits'
import type { RuntimeModel } from '../../foundation/envelope.js'
import type { ConversationRepository } from './conversation.repository.js'
import type { AgentTitleService, FirstTurnTitle } from './title.service.js'
import type { RunStatusStream } from '../run/run-status.stream.js'

/** 兜底会话名：首条消息里没有可用文字时用它，**不拿 URL 当名字** */
export const DEFAULT_CONVERSATION_TITLE = '新对话'

/**
 * 这条消息能不能直接拿来当标题。
 *
 * 为什么不能直接用：首条消息经常只贴了一个链接（"帮我看看这个"），截 40 字得到的
 * 是一串 `https://…` 或裸域名 —— 侧栏里两行都一样，谁也认不出是哪次对话。
 * 判据刻意保守：只拒绝"整体就是一个链接 / 域名 / 纯符号"的消息，正常中文开头的一句
 * 带链接的话仍然照常截断（那句话本身有信息量）。
 */
export const looksLikeUrlOnly = (text: string): boolean => {
  const compact = text.trim()
  if (!compact) return true
  if (/^https?:\/\/\S+$/i.test(compact)) return true
  if (/^www\.\S+$/i.test(compact)) return true
  // 裸域名（例如 example.com/path）：要求整串只有域名与路径，不含空格
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?(\?\S*)?$/i.test(compact)) return true
  // 纯标点 / 纯符号
  return !/[\p{L}\p{N}]/u.test(compact)
}

/** 用首条用户消息生成会话标题（不额外调模型，省钱）；没有可用文字时给默认名 */
export const titleFrom = (message: string): string => {
  const text = message.replace(/\s+/g, ' ').trim()
  if (looksLikeUrlOnly(text)) return DEFAULT_CONVERSATION_TITLE
  return text.slice(0, 40)
}

/** 首轮命名需要的最小依赖（chat.service 已有这些实例，构造后直接传） */
export interface FirstTurnTitleDeps {
  conversations: ConversationRepository
  titles: AgentTitleService
  logger: AppLogger
  runEvents?: RunStatusStream | null
}

/**
 * **首轮命名的前提**：这一轮是首轮，且标题还是「兜底那版」。
 *
 * 首轮之后（`turnCount > 0`）不再自动改名；用户中途改过名（标题已不是
 * `titleFrom(首条消息)`）也永远听用户的 —— 后台不许悄悄冲掉人工名字。
 */
export const needsFirstTurnTitle = (conversation: ConversationEntity, message: string): boolean => {
  if (conversation.turnCount > 0) return false
  return !conversation.title || conversation.title === titleFrom(message)
}

/**
 * **首轮命名**：run 一启动就和主回答**并行**跑（早就不在收尾里做了）。
 *
 * - 先落兜底名（首条消息截出来的那版），侧栏立刻有名字，不用等模型；
 * - 名字一回来就落库 + 推整站 SSE（`conversation.title.changed`），前端当场更新；
 * - 失败（超时 / 报错 / 被取消）只 warn 并保住兜底名 —— 返回的 promise **不会 reject**，
 *   调用方在收尾处 `await` 它，只为把这次调用的 token 并进这一轮的账。
 *
 * `signal` 是这一轮的中止信号：用户点停止 → 命名调用一起断开。
 */
export const startFirstTurnTitle = (
  deps: FirstTurnTitleDeps,
  conversation: ConversationEntity,
  runId: string,
  message: string,
  model: RuntimeModel,
  signal?: AbortSignal,
): Promise<FirstTurnTitle | null> => {
  if (!needsFirstTurnTitle(conversation, message)) return Promise.resolve(null)
  // 立即起跑（async IIFE 同步执行到第一个 await）：兜底名先落，再等模型
  return (async () => {
    await writeFallbackTitle(deps, conversation, message)
    const generated = await deps.titles.generateFirstTurnTitle({
      conversationId: conversation.id,
      runId,
      message,
      model,
      ...(signal ? { signal } : {}),
    })
    if (generated?.title) await commitTitle(deps, conversation, message, generated.title)
    return generated
  })().catch((error: unknown) => {
    // 起名是"锦上添花"：任何意外都不能影响这一轮，更不能让调用方的 await 炸掉收尾
    deps.logger.warn('ai.conversation.title_failed', {
      conversationId: conversation.id,
      runId,
      reason: error instanceof Error ? error.message : String(error),
    })
    return null
  })
}

/**
 * 落**兜底名**：只在标题还空着时写（用户改过的名、模型起的名都不动）。
 * 失败只 warn —— 起名是锦上添花，不能影响这一轮。
 */
export const writeFallbackTitle = async (
  deps: FirstTurnTitleDeps,
  conversation: ConversationEntity,
  message: string,
): Promise<void> => {
  if (conversation.title) return
  try {
    const title = titleFrom(message)
    await deps.conversations.setTitle(conversation.id, title)
    conversation.title = title
  } catch (error) {
    deps.logger.warn('ai.conversation.title_fallback_failed', {
      conversationId: conversation.id,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * 落**模型起的名字**：写库前重读一次标题 —— 命名与主回答并行，这段等待期间用户可能
 * 已经手动改名（那就永远听用户的）。落库后推整站 SSE，侧栏 / 页头不用等下一次刷新。
 */
const commitTitle = async (
  deps: FirstTurnTitleDeps,
  conversation: ConversationEntity,
  message: string,
  title: string,
): Promise<void> => {
  const fallback = titleFrom(message)
  const fresh = await deps.conversations.findEntity(conversation.id)
  if (!fresh) return
  if (fresh.title && fresh.title !== fallback) return
  await deps.conversations.setTitle(conversation.id, title)
  conversation.title = title
  await deps.runEvents?.titleChanged(conversation.id, title)
}
