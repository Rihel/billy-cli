import type { UIMessage } from 'ai'
import type { QuestionAnswer, SuspendedPartData } from './question-card'

/**
 * 「这组问题已经回答完」这件事怎么落到消息上（纯函数，node 环境可单测）。
 *
 * 为什么单独成文件：会话页的续跑链路有两条时序要求（见 `chat-conversation.tsx` 的
 * `answerQuestions`），其中一条是**提交那一刻就要把卡片标成已回答** —— 否则服务端已经
 * 开始输出、dock 上还挂着问题卡与「提交中…」，看起来像"没提交成功"。
 *
 * 这段改写既用于"提交时的乐观标记"，也用于"续跑流回来的每一帧"（服务端块只带
 * `resumed: true`，会把问题原文冲掉，得从提交前那份挂起数据里补回来），所以必须是
 * 同一个函数 —— 两条路径各写一份必然漂移。
 */

export interface AnsweredPatch {
  /** 这次回答对应的工具调用 id（挂起块用它认自己） */
  toolCallId?: string
  /** 用户交上来的答案（整组） */
  answers: QuestionAnswer[]
  /** 提交前那份挂起数据：续跑块不带问题原文时从这里补（可缺省） */
  suspendPayload?: SuspendedPartData['suspendPayload']
}

/**
 * 把消息里**这次问答**的挂起块改成只读问答记录。
 *
 * 只改这一块：其它 part 原样返回（引用不变），于是归约层与行级 memo 不会因这次改写作废。
 * 认块的口径与续跑流一致：优先 `data.toolCallId`，退化用 part 自己的 `id`。
 */
export const markSuspendedAnswered = (
  message: UIMessage,
  patch: AnsweredPatch,
): UIMessage => {
  let changed = false
  const parts = message.parts.map((part) => {
    if (part.type !== 'data-tool-call-suspended') return part
    const data = (part as { data?: SuspendedPartData }).data
    const callId = data?.toolCallId ?? (part as { id?: string }).id
    if (callId !== patch.toolCallId) return part
    changed = true
    return {
      ...part,
      data: {
        ...data,
        // 提交那一刻就置 `resumed`：dock 上的问题卡立刻收起、时间线里改为只读记录
        resumed: true,
        suspendPayload: data?.suspendPayload ?? patch.suspendPayload,
        answers: patch.answers,
      },
    } as typeof part
  })
  return changed ? { ...message, parts } : message
}
