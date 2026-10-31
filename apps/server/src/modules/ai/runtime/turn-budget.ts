/**
 * 轮内上下文预算：**每一步开始前**把"工具结果"的累计体积压回预算内。
 *
 * 为什么需要它：上下文压缩只在每轮开始前判定一次（见 `chat.service` 的 `buildContext`），
 * 而一轮里的工具往返可以有几十步 —— 主 run 的工具结果堆到几百 KB 是真实发生过的。
 * 等这一轮结束再压缩，钱已经烧掉了。
 *
 * 边界（刻意如此）：
 * - **只动"给模型的视图"**：时间线里的出参由 `stream-recorder` 全量落库，这里改的是
 *   Mastra 每一步拿去请求模型的那份消息（`prepareStep` 的入参）；
 * - **只压工具结果**，不动文本 / 推理 / 系统提示词 —— 文本是用户看过的内容，
 *   压掉等于篡改对话；工具结果原本就有"完整内容在库里、可用 `read-tool-result` 取回"的约定；
 * - **保留最近 N 条**：模型当下正在用的结果不能动，否则下一步会"忘记刚才看到了什么"。
 */

/** 单条被截断结果保留的预览长度（字符） */
const PREVIEW_CHARS = 400;

export interface ToolBudgetOptions {
  /** 本轮工具结果允许占用的总字符数（由窗口换算而来） */
  budgetChars: number;
  /** 最近几条工具结果不动（默认 4） */
  keepRecent?: number;
}

export interface ToolBudgetResult {
  /** 需要替换时是**新数组**（原数组与原始消息对象不被修改）；无需改动时就是入参本身 */
  messages: unknown[];
  trimmedCount: number;
  beforeChars: number;
  afterChars: number;
}

/** 截断标记：让模型知道"这里被压过"，而不是以为工具只返回了这么点 */
const TRUNCATED_NOTE = '…[轮内上下文预算已截断；完整内容已入库，需要细节可重新调用工具或取回原文]';

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value ?? '')
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 一条可压缩的工具结果在消息数组里的位置 */
interface Candidate {
  messageIndex: number
  partIndex: number
  /** tool-invocation 用：part 内的 toolInvocation；tool-result 用：part 本身 */
  holder: Record<string, unknown>
  chars: number
}

/**
 * 从一条消息里找出所有"带结果"的工具片段。
 *
 * 两种形态都认：
 * 1. Mastra 的库消息（`prepareStep` 拿到的）：`content.parts[]`，片段
 *    `{ type: 'tool-invocation', toolInvocation: { state: 'result', result } }`；
 * 2. AI SDK 的模型消息：`content[]` 里 `{ type: 'tool-result', output }`（历史重放用）。
 * 认不出来就当没有 —— 压错了比不压更糟。
 */
const collectCandidates = (messages: unknown[]): Candidate[] => {
  const found: Candidate[] = []
  messages.forEach((message, messageIndex) => {
    if (!isRecord(message)) return
    const content = message.content
    const parts = Array.isArray(content)
      ? content
      : isRecord(content) && Array.isArray(content.parts)
        ? (content.parts as unknown[])
        : null
    if (!parts) return
    parts.forEach((part, partIndex) => {
      if (!isRecord(part)) return
      if (part.type === 'tool-invocation' && isRecord(part.toolInvocation)) {
        const invocation = part.toolInvocation
        if (invocation.state !== 'result' || invocation.result === undefined) return
        found.push({
          messageIndex,
          partIndex,
          holder: invocation,
          chars: safeStringify(invocation.result).length,
        })
        return
      }
      if (part.type === 'tool-result' && part.output !== undefined) {
        found.push({
          messageIndex,
          partIndex,
          holder: part,
          chars: safeStringify(part.output).length,
        })
      }
    })
  })
  return found
}

/** 预览：把结果换成"截断标记 + 开头一小段"，形态尽量不破坏原来的结构 */
const shrinkValue = (value: unknown, previewChars: number): unknown => {
  const serialized = safeStringify(value)
  return {
    truncated: true,
    note: TRUNCATED_NOTE,
    preview: serialized.slice(0, previewChars),
  }
}

/**
 * 把消息里的工具结果压到预算内。
 *
 * 从**最新往最旧**处理、跳过最近 `keepRecent` 条：只有"旧的"才值得牺牲。
 * 一旦总量回到预算内就停手，不做多余的截断。
 */
export const fitMessagesToToolBudget = (
  messages: unknown,
  options: ToolBudgetOptions,
): ToolBudgetResult => {
  const list = Array.isArray(messages) ? messages : []
  const candidates = collectCandidates(list)
  const beforeChars = candidates.reduce((sum, item) => sum + item.chars, 0)
  const budget = Math.max(0, options.budgetChars)
  if (beforeChars <= budget || candidates.length === 0) {
    return { messages: list, trimmedCount: 0, beforeChars, afterChars: beforeChars }
  }

  const keepRecent = Math.max(0, options.keepRecent ?? 4)
  const shrinkable = candidates.slice(0, Math.max(0, candidates.length - keepRecent))
  if (shrinkable.length === 0) {
    return { messages: list, trimmedCount: 0, beforeChars, afterChars: beforeChars }
  }

  // 复制一份，只有真正改动的消息才回填 —— 没压过的那几条保持原对象（避免无谓的拷贝）
  const next = [...list]
  let total = beforeChars
  let trimmedCount = 0
  for (const candidate of [...shrinkable].reverse()) {
    if (total <= budget) break
    const message = next[candidate.messageIndex]
    if (!isRecord(message)) continue
    const part = Array.isArray(message.content)
      ? (message.content as unknown[])[candidate.partIndex]
      : (message.content as { parts?: unknown[] })?.parts?.[candidate.partIndex]
    if (!isRecord(part)) continue
    const clonePart = { ...part }
    if (part.type === 'tool-invocation' && isRecord(part.toolInvocation)) {
      const invocation = { ...part.toolInvocation }
      invocation.result = shrinkValue(invocation.result, PREVIEW_CHARS)
      clonePart.toolInvocation = invocation
    } else {
      clonePart.output = shrinkValue(part.output, PREVIEW_CHARS)
    }
    const cloneMessage = Array.isArray(message.content)
      ? { ...message, content: replaceAt(message.content as unknown[], candidate.partIndex, clonePart) }
      : {
          ...message,
          content: {
            ...(message.content as Record<string, unknown>),
            parts: replaceAt(
              (message.content as { parts?: unknown[] }).parts ?? [],
              candidate.partIndex,
              clonePart,
            ),
          },
        }
    next[candidate.messageIndex] = cloneMessage
    const shrunkChars = safeStringify(clonePart).length
    total -= candidate.chars - shrunkChars
    trimmedCount += 1
  }

  if (trimmedCount === 0) {
    return { messages: list, trimmedCount: 0, beforeChars, afterChars: beforeChars }
  }
  return { messages: next, trimmedCount, beforeChars, afterChars: total }
}

const replaceAt = <T>(list: T[], index: number, value: T): T[] => {
  const copy = [...list]
  copy[index] = value
  return copy
}
