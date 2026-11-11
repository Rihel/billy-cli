/**
 * 断线补发的片段整形（纯函数，便于测试）。
 *
 * 背景：`resumeRun` 会从客户端上报的 `offset` 开始补发。offset 可能落在
 * 一个正在流式的块中间 —— 例如先收到 `reasoning-start`，随后断线，重连时
 * offset 已经指向后面的 `reasoning-delta`。AI SDK 的 UI Message Stream 是
 * 一个**有状态**的状态机，收到没有对应 start 的 delta 会直接抛：
 *
 *   Received reasoning-delta for missing reasoning part with ID "reasoning-2"
 *
 * 修法：把补发起点**回退到当前块的开头**（reasoning / text / tool-input），
 * 让客户端从完整块重建；如果起点之前的记录已经被 Redis 截断、找不到开头，
 * 就补一个合成的 start（至少不让整页 500）。孤立的 end 直接丢弃。
 */

export interface ResumeChunk {
  type?: string
  id?: string
  toolCallId?: string
  delta?: string
  [key: string]: unknown
}

/** 增量/结束块 → 它依赖的开头块 */
const OPENER_OF: Record<string, string> = {
  'reasoning-delta': 'reasoning-start',
  'reasoning-end': 'reasoning-start',
  'text-delta': 'text-start',
  'text-end': 'text-start',
  'tool-input-delta': 'tool-input-start',
  'tool-output-available': 'tool-input-available',
  'tool-output-error': 'tool-input-available',
}

const idOf = (chunk: ResumeChunk | undefined): string =>
  typeof chunk?.id === 'string' ? chunk.id : typeof chunk?.toolCallId === 'string' ? chunk.toolCallId : ''

/**
 * 从 `offset` 开始，返回一段可以安全补发的片段。
 *
 * - 若 offset 落在某个块中间，回退到该块的开头；
 * - 回退后仍缺 start（Redis 已截断）时补一个 start；
 * - 缺 start 的 end 丢弃，避免 UI 状态机报 "missing reasoning part"。
 */
export function resumeSafeChunks(all: ResumeChunk[], offset: number): ResumeChunk[] {
  const raw = Math.max(0, Math.floor(offset))
  if (raw > all.length) return []
  if (raw === all.length && all.length === 0) return []

  /**
   * offset 正好等于当前长度（断在最后一块之后）同样危险：
   * 客户端状态是新建的，下一条实时片段可能就是一个 reasoning-delta，
   * 而它的 start 已经在 offset 之前。所以要看最后一块是不是仍在流式中的块，
   * 是的话把起点回退到它的开头。
   */
  const atEnd = raw === all.length
  const from = atEnd ? all.length - 1 : raw
  const head = all[from]

  if (atEnd) {
    const type = head?.type
    // 块已结束 / 没有依赖 start 的片段：没有需要补发的活动块
    if (!type) return []
    if (type.endsWith('-end') || type === 'finish' || type === 'error') return []
    // 刚打开的块：把 start 本身补回去；其余类型只有增量需要回退
    if (type !== 'start' && !type.endsWith('-start') && !OPENER_OF[type]) return []
  }

  const opener = head?.type ? OPENER_OF[head.type] : undefined
  let start = from

  if (opener) {
    for (let i = from - 1; i >= 0; i -= 1) {
      const candidate = all[i]
      if (candidate?.type === opener && idOf(candidate) === idOf(head)) {
        start = i
        break
      }
    }
  }

  let out = all.slice(start)
  /**
   * 回退到块开头后，消息的 `start` 很可能落在回退点之前；补回来，
   * 否则客户端会丢掉 messageId / 再 push 一条消息（前端出现两份回答）。
   * 只补 `start`，不重放中间的工具调用，避免重复。
   */
  if (start > 0 && out[0]?.type !== 'start') {
    const messageStart = all
      .slice(0, start)
      .reverse()
      .find((chunk) => chunk?.type === 'start')
    if (messageStart) out = [messageStart, ...out]
  }
  return ensureStarts(out)
}

/** 补 start / 丢孤立 end；按 id 维护当前打开的块 */
function ensureStarts(chunks: ResumeChunk[]): ResumeChunk[] {
  const openReasoning = new Set<string>()
  const openText = new Set<string>()
  const openToolInput = new Set<string>()
  const availableTools = new Set<string>()
  const out: ResumeChunk[] = []

  /** toolCallId → toolName：合成 tool-input-start 时 schema 要求这两个字段，不能只给 id */
  const toolNames = new Map<string, string>()
  for (const chunk of chunks) {
    const id = idOf(chunk)
    const name = typeof chunk.toolName === 'string' ? chunk.toolName : undefined
    if (id && name && (chunk.type === 'tool-input-start' || chunk.type === 'tool-input-available')) {
      toolNames.set(id, name)
    }
  }
  const toolStart = (id: string): ResumeChunk => ({
    type: 'tool-input-start',
    id,
    toolCallId: id,
    toolName: toolNames.get(id) ?? 'unknown',
  })

  const open = (set: Set<string>, id: string): boolean => {
    if (set.has(id)) return false
    set.add(id)
    return true
  }

  for (const chunk of chunks) {
    const id = idOf(chunk)
    switch (chunk?.type) {
      case 'reasoning-start':
        open(openReasoning, id)
        out.push(chunk)
        break
      case 'reasoning-delta':
        if (open(openReasoning, id)) out.push({ type: 'reasoning-start', id })
        out.push(chunk)
        break
      case 'reasoning-end':
        if (!openReasoning.has(id)) break
        openReasoning.delete(id)
        out.push(chunk)
        break
      case 'text-start':
        open(openText, id)
        out.push(chunk)
        break
      case 'text-delta':
        if (open(openText, id)) out.push({ type: 'text-start', id })
        out.push(chunk)
        break
      case 'text-end':
        if (!openText.has(id)) break
        openText.delete(id)
        out.push(chunk)
        break
      case 'tool-input-start':
        open(openToolInput, id)
        // 老记录可能只有 id；补齐 schema 要求的 toolCallId / toolName
        out.push({
          ...chunk,
          toolCallId: typeof chunk.toolCallId === 'string' ? chunk.toolCallId : id,
          toolName:
            typeof chunk.toolName === 'string' ? chunk.toolName : (toolNames.get(id) ?? 'unknown'),
        })
        break
      case 'tool-input-delta':
        if (open(openToolInput, id)) out.push(toolStart(id))
        out.push(chunk)
        break
      case 'tool-input-available':
        openToolInput.delete(id)
        availableTools.add(id)
        out.push(chunk)
        break
      case 'tool-input-error':
        openToolInput.delete(id)
        out.push(chunk)
        break
      case 'tool-output-available':
      case 'tool-output-error':
        // 没有对应的 tool-input-available 时不能发 output：AI SDK 会报
        // `No tool invocation found for tool call ID ...`。宁可不补这条结果，也不打挂整页。
        if (!availableTools.has(id)) break
        out.push(chunk)
        break
      default:
        out.push(chunk)
    }
  }

  return out
}
