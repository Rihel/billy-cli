import { TimelineKind, TimelineRole, type AgUiChunk } from '@repo/shared'
import type { TimelineEntity } from '@repo/db'

/**
 * 时间线 → 快照 parts（服务端版本）。
 *
 * 为什么快照必须从 `timelines` 构建，而不是从 Redis 输出记录：
 * 输出记录有 **20k 条 / 32MB** 上限，长轮次会从头部裁剪 —— 裁剪后记录里既没有
 * `start`（消息 id），也没有早期已闭合的正文/工具卡。拿它当快照会得到一条**残缺的新消息**
 * （2026-11-17 实测：同一条回答被拆成两条，子助手卡出现两组）。
 *
 * 口径与前端 `history.ts` 的 `toParts` 保持一致（历史与快照必须能落在同一条消息上）：
 * - 文本 / 推理 / 工具卡（`dynamic-tool`）/ 问题卡 / 计划 / 子助手卡 / 完成通知；
 * - 工具卡按“调用发生的位置”就地铺开，结果到达时补在**同一张卡**上；
 * - 计划统一追加在末尾（会话页把“当前计划”渲染在消息末尾）。
 */

const TEXT = TimelineKind.Text
const REASONING = TimelineKind.Reasoning
const TOOL_CALL = TimelineKind.ToolCall
const TOOL_RESULT = TimelineKind.ToolResult
const TOOL_SUSPENDED = TimelineKind.ToolSuspended
const PLAN = TimelineKind.Plan
const SUMMARY = TimelineKind.Summary
const STATUS = TimelineKind.Status

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const textOf = (item: TimelineEntity): string => {
  const text = item.payload?.text
  return typeof text === 'string' ? text : ''
}

/**
 * 时间线行里记下的 **part id**（`stream-recorder.flushText/flushReasoning` 写入）。
 *
 * 老行没有这个字段（返回 undefined）：映射出来的 part 也就不带 id，
 * 重连时无法与增量对齐 —— 这是兼容旧数据的有意退让，不是漏写。
 */
const idOf = (item: TimelineEntity): string | undefined => {
  const id = item.payload?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

const durationOf = (item: TimelineEntity | undefined): number | undefined => {
  const audited = asRecord(item?.payload?.outcome)?.durationMs
  if (typeof audited === 'number' && Number.isFinite(audited)) return audited
  const own = item?.durationMs
  return typeof own === 'number' && Number.isFinite(own) ? own : undefined
}

interface ToolPart {
  type: 'dynamic-tool'
  toolName: string
  toolCallId: string
  state: 'input-available' | 'output-available' | 'output-error'
  input?: unknown
  output?: unknown
  errorText?: string
  durationMs?: number
}

const toToolPart = (call: TimelineEntity | undefined, result?: TimelineEntity): ToolPart => {
  const isError = result?.payload?.isError === true || result?.state === 'output-error'
  const output = result?.payload?.output
  const durationMs = durationOf(result)
  return {
    type: 'dynamic-tool',
    toolName: String(call?.toolKey ?? result?.toolKey ?? 'tool'),
    toolCallId: String(
      call?.toolCallId ?? result?.toolCallId ?? `tool-${call?.seq ?? result?.seq ?? 0}`,
    ),
    state: result ? (isError ? 'output-error' : 'output-available') : 'input-available',
    input: call?.payload?.input,
    ...(result ? (isError ? { errorText: JSON.stringify(output ?? '') } : { output }) : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  }
}

const applyResult = (part: ToolPart, result: TimelineEntity): void => {
  const isError = result.payload?.isError === true || result.state === 'output-error'
  const output = result.payload?.output
  part.state = isError ? 'output-error' : 'output-available'
  if (isError) part.errorText = JSON.stringify(output ?? '')
  else part.output = output
  const durationMs = durationOf(result)
  if (durationMs !== undefined) part.durationMs = durationMs
}

/** 子助手工具结果 → 子助手卡（与实时 `data-sub-agent` 同形状） */
const subAgentPartOf = (
  result: TimelineEntity,
  toolName: string,
): Record<string, unknown> | null => {
  if (toolName !== 'run-sub-agent') return null
  const output = asRecord(result.payload?.output)
  const subRunId = output?.subRunId
  if (typeof subRunId !== 'string') return null
  return {
    type: 'data-sub-agent',
    id: subRunId,
    // `toolCallId` 是前端把"原始工具卡"标记成 delegated 的依据；少了它会多出一张工具卡
    data: {
      ...output,
      runId: subRunId,
      ...(result.toolCallId ? { toolCallId: result.toolCallId } : {}),
    },
  }
}

/** `subagent_completed` 状态行 → 完成通知卡 */
const completedPartOf = (item: TimelineEntity): Record<string, unknown> | null => {
  const payload = item.payload ?? {}
  if (payload.status !== 'subagent_completed') return null
  const subRunId =
    typeof payload.subRunId === 'string' && payload.subRunId.length > 0
      ? payload.subRunId
      : `notice-${item.seq}`
  return { type: 'data-subagent-completed', id: subRunId, data: payload }
}

/**
 * 时间线行 → 快照 parts。
 *
 * `items` 必须是**同一个 run** 的行（按 seq 升序）；调用方用 `TimelineRepository.listByRun`。
 */
export const buildMessageParts = (
  items: readonly TimelineEntity[],
): Array<Record<string, unknown>> => {
  const parts: Array<Record<string, unknown>> = []
  const pending = new Map<string, ToolPart>()
  const plans: TimelineEntity[] = []
  /** 已回答的问题（toolCallId → 出参），用于把挂起卡标成只读 */
  const answers = new Map<string, unknown>()
  for (const item of items) {
    if (item.kind === TOOL_RESULT && item.toolKey === 'ask-user-questions' && item.toolCallId) {
      answers.set(item.toolCallId, item.payload?.output)
    }
  }

  for (const item of items) {
    if (item.role === TimelineRole.User) continue
    switch (item.kind) {
      case TEXT: {
        const text = textOf(item)
        // `id` 是新行才有的（老行没存 part id）：带上它才能和增量对齐、避免同一段补两遍
        const partId = idOf(item)
        // `state: 'done'` 与实时流同构：`readUIMessageStream` 归约出来的 text part 收尾就是这个状态，
        // 快照种子缺了它，前端按 state 判断"是否仍在流式"（光标 / 动画）时恢复后的段落与实时不一致。
        if (text)
          parts.push({ type: 'text', text, state: 'done', ...(partId ? { id: partId } : {}) })
        break
      }
      case REASONING: {
        const text = textOf(item)
        if (!text) break
        const durationMs = durationOf(item)
        const partId = idOf(item)
        parts.push({
          type: 'reasoning',
          text,
          state: 'done',
          ...(partId ? { id: partId } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        })
        break
      }
      case TOOL_CALL: {
        if (item.toolKey === 'ask-user-questions') break
        const part = toToolPart(item)
        parts.push(part as unknown as Record<string, unknown>)
        if (item.toolCallId) pending.set(item.toolCallId, part)
        break
      }
      case TOOL_SUSPENDED: {
        const toolCallId = item.toolCallId ?? undefined
        const answered = toolCallId ? answers.has(toolCallId) : false
        const output = toolCallId ? answers.get(toolCallId) : undefined
        const record = asRecord(output)
        const structured = record?.answers
        parts.push({
          type: 'data-tool-call-suspended',
          id: toolCallId ?? `suspended-${item.seq}`,
          data: {
            runId: item.payload?.runId ?? undefined,
            toolCallId,
            toolName: item.toolKey ?? 'ask-user-questions',
            suspendPayload: item.payload?.suspendPayload,
            resumeSchema: item.payload?.resumeSchema,
            resumed: answered,
            ...(record?.cancelled === true ? { cancelled: true } : {}),
            ...(Array.isArray(structured) ? { answers: structured } : {}),
          },
        })
        break
      }
      case TOOL_RESULT: {
        if (item.toolKey === 'ask-user-questions') break
        const part = item.toolCallId ? pending.get(item.toolCallId) : undefined
        if (part) {
          applyResult(part, item)
          const subAgent = subAgentPartOf(item, part.toolName)
          if (subAgent) parts.push(subAgent)
          break
        }
        // 只有结果没有调用（历史残留）：也补一张卡，位置不能挪到末尾
        const orphan = toToolPart(undefined, item)
        parts.push(orphan as unknown as Record<string, unknown>)
        const subAgent = subAgentPartOf(item, orphan.toolName)
        if (subAgent) parts.push(subAgent)
        break
      }
      case SUMMARY: {
        const text = textOf(item)
        if (!text) break
        parts.push({
          type: 'data-summary',
          id: `summary-${item.seq}`,
          data: { text, covers: item.payload?.coversSeqs },
        })
        break
      }
      case PLAN:
        plans.push(item)
        break
      case STATUS: {
        const notice = completedPartOf(item)
        if (notice) parts.push(notice)
        break
      }
      default:
        break
    }
  }

  for (const item of plans) {
    parts.push({ type: 'data-plan', id: `plan-${item.seq}`, data: item.payload ?? {} })
  }
  return parts
}

/**
 * 快照 parts → 重放 chunk（保持 part id；文本/推理用位置生成稳定 id）。
 *
 * 不直接把 parts 塞给前端，是因为前端传输层只认 chunk（`useChat` 的状态机）；
 * 这里做的正是“快照 parts → 事件流”的最后一公里。
 */
export const snapshotPartsToChunks = (
  parts: ReadonlyArray<Record<string, unknown>>,
): AgUiChunk[] => {
  const chunks: AgUiChunk[] = []
  parts.forEach((part, index) => {
    const type = String(part.type ?? '')
    if (type === 'text') {
      const text = String(part.text ?? '')
      if (!text) return
      const id = `snap-text-${index}`
      chunks.push(
        { type: 'text-start', id },
        { type: 'text-delta', id, delta: text },
        { type: 'text-end', id },
      )
      return
    }
    if (type === 'reasoning') {
      const text = String(part.text ?? '')
      if (!text) return
      const id = `snap-reasoning-${index}`
      chunks.push(
        { type: 'reasoning-start', id },
        { type: 'reasoning-delta', id, delta: text },
        { type: 'reasoning-end', id },
      )
      return
    }
    if (type === 'dynamic-tool') {
      const toolCallId = String(part.toolCallId ?? `snap-tool-${index}`)
      const toolName = String(part.toolName ?? 'tool')
      const input = part.input
      chunks.push(
        { type: 'tool-input-start', toolCallId, toolName },
        { type: 'tool-input-delta', toolCallId, inputTextDelta: JSON.stringify(input ?? null) },
        { type: 'tool-input-available', toolCallId, toolName, input },
      )
      if (part.state === 'output-error') {
        chunks.push({
          type: 'tool-output-error',
          toolCallId,
          errorText: String(part.errorText ?? '工具执行失败'),
        })
      } else if (part.state === 'output-available') {
        chunks.push({ type: 'tool-output-available', toolCallId, output: part.output })
      }
      return
    }
    if (type.startsWith('data-')) {
      chunks.push({
        type,
        ...(typeof part.id === 'string' && part.id ? { id: part.id } : {}),
        data: part.data,
      })
    }
  })
  return chunks
}
