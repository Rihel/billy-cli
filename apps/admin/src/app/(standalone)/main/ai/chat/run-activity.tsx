'use client'

import {
  getToolName,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from 'ai'
import { LoaderCircleIcon } from 'lucide-react'
import { isSubAgentActive, liveSubAgentsOf } from './sub-agent-live'

/**
 * **输入框上方**的运行指示：转圈 + 一句会变的中文状态（不跟消息滚走）。
 *
 * 为什么需要它：一轮问答里模型可能连续跑几十次工具、几分钟不吐正文，
 * 界面上除了**已经发生**的内容没有任何"它在干活"的信号 —— 用户会怀疑卡死。
 *
 * 状态文案**只从既有数据里挑**（`status` + 最后一条消息的 parts），不新增任何后端字段：
 * 优先级从上到下就是"最靠后发生的事"——子助手在跑 > 工具在调 > 推理/正文在写。
 * 文案变化时组件**高度不变**（`h-6` 固定），所以不会把时间线顶得跳来跳去。
 */

/** 工具名兜底：拿不到名字时别把状态句读成残句 */
const toolLabel = (name: string): string => (name ? ` ${name}` : '工具')

/**
 * 运行状态文案（纯函数，可单测）。**返回 `null` = 这一轮已经结束，指示不该出现**。
 *
 * 扫描顺序**从 parts 末尾往前**：最后发生的那件事才代表"现在在干什么"。
 * 已经收尾的工具（`output-available` / `output-error`）不算信号，继续往前找 ——
 * 它后面可能还有正文或下一轮推理。
 *
 * "结不结束"由 `status` **在这一处**判定（而不是让调用方再包一层 `streaming ? … : null`）：
 * 出现 / 消失是用户感知的核心，判据收在纯函数里才有用例钉得住 ——
 * 换个调用方也不会漏判，不会留下一个转不停的残影。
 */
export const runActivityText = (
  messages: readonly UIMessage[],
  status: string,
): string | null => {
  if (status !== 'streaming' && status !== 'submitted') return null
  if (status === 'submitted') return '正在准备…'

  // 子助手在跑时它才是"当前正在干活的那个"（主 agent 在等它返回）
  const activeSubAgent = liveSubAgentsOf(messages).find(isSubAgentActive)
  if (activeSubAgent) return `子助手「${activeSubAgent.name}」正在干活…`

  const parts = messages.at(-1)?.parts ?? []
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!
    if (isReasoningUIPart(part)) {
      if (part.state === 'streaming') return '正在思考…'
      continue
    }
    if (isToolUIPart(part)) {
      const name = getToolName(part)
      if (part.state === 'input-streaming') return `正在准备调用${toolLabel(name)}…`
      if (part.state === 'input-available') return `正在调用${toolLabel(name)}…`
      continue
    }
    if (isTextUIPart(part)) {
      if (part.text.trim()) return '正在输出…'
      continue
    }
  }
  return '正在思考…'
}

/**
 * 输入框上方的运行指示。
 *
 * **自己判断该不该出现**（文案为 `null` 就返回 `null`）：这一轮没在跑就什么都不渲染，
 * 组件卸载 / 不渲染都不会留残影。`role="status"` + 固定高度（`h-6`）：
 * 屏幕阅读器会播报状态变化，视觉上也不会让时间线跳动。
 */
export function RunActivity({
  messages,
  status,
}: {
  messages: readonly UIMessage[]
  status: string
}) {
  const text = runActivityText(messages, status)
  if (!text) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-6 items-center gap-2 px-1 text-xs text-muted-foreground"
    >
      <LoaderCircleIcon className="size-3.5 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
      <span>{text}</span>
    </div>
  )
}
