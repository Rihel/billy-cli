import {
  TimelineKind,
  TimelineRole,
  type AgentRunModel,
  type AgentTimelineItemModel,
} from '@repo/shared'
import type { UIMessage } from 'ai'

/**
 * 时间线（数据库里的真相）→ UI 消息（AI SDK 的 `UIMessage`）。
 *
 * 为什么要这份映射：`useChat` 只认 `UIMessage`，而**历史不在浏览器里** ——
 * 刷新 / 换设备 / 换会话后，内容只能从 `timelines` 重建（设计文档 §3.13 第 ③ 条）。
 * 映射规则刻意保持"无损但不高保真"：
 *
 * 1. **只有根 run 的事件变成消息**（子 agent 的明细不铺进主对话，见第 3 条）；
 * 2. 一行时间线事件 → 一个 part：`text` / `reasoning` / 工具调用与结果（按 `tool_call_id` 配对）
 *    / `plan`（合成 `data-plan`，与会话页里的计划面板对齐）；
 * 3. `run-sub-agent` 的结论额外合成一条 `data-sub-agent` part —— 于是**历史里的子助手卡片
 *    与实时流看到的是同一种结构**（面板组件只认这一种 part）；
 * 4. **顺序与实时流一致**：工具卡按"调用发生的位置"就地铺开（结果到达时补出参），
 *    不能攒到最后统一追加 —— 那会让刷新后的历史与当时的界面长得不一样；
 * 4. 子 agent 的**完整过程**（推理 / 工具往返）不进主对话：它在子 run 的时间线里，
 *    由面板按需拉取（同一套只读接口，见 §3.14.3）。
 */

const textOf = (item: AgentTimelineItemModel): string => {
  const text = item.payload?.text
  return typeof text === 'string' ? text : ''
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null

/**
 * 把某个会话的时间线重建为消息列表。
 *
 * @param items 该会话的时间线（**含子 agent 的事件**，函数内部按 `runs` 过滤）
 * @param runs  该会话的运行列表（用来区分根 run 与子 run）
 */
export const toUIMessages = (
  items: AgentTimelineItemModel[],
  runs: AgentRunModel[],
): UIMessage[] => {
  const rootRunIds = new Set(
    runs.filter((run) => run.parentRunId === null).map((run) => run.id),
  )

  // 按 run 分组（保持时间线顺序），只有根 run 进入主对话
  const byRun = new Map<string, AgentTimelineItemModel[]>()
  for (const item of items) {
    if (!item.runId || !rootRunIds.has(item.runId)) continue
    const list = byRun.get(item.runId)
    if (list) list.push(item)
    else byRun.set(item.runId, [item])
  }

  const messages: UIMessage[] = []
  const runById = new Map(runs.map((run) => [run.id, run]))
  for (const [runId, events] of [...byRun.entries()].sort(
    (a, b) => (a[1][0]?.seq ?? 0) - (b[1][0]?.seq ?? 0),
  )) {
    const sorted = [...events].sort((a, b) => a.seq - b.seq)

    const userText = sorted
      .filter((item) => item.kind === TimelineKind.Text && item.role === TimelineRole.User)
      .map(textOf)
      .filter(Boolean)
      .join('\n')
    if (userText) {
      messages.push({
        id: `${runId}-user`,
        role: 'user',
        parts: [{ type: 'text', text: userText }],
      })
    }

    const parts = toParts(sorted)
    // 用量：实时是收尾下发的 `data-run-usage`，历史（刷新 / 切会话）只能从 runs 重建 ——
    // 缺了它，回看历史时就只剩正文、统计全空（用户看到的"统计只在当场那一轮有"）。
    // 追加在最后，与实时流的位置一致。
    const run = runById.get(runId)
    if (run?.usage) {
      parts.push({
        type: 'data-run-usage',
        data: {
          runId,
          usage: run.usage,
          stepCount: run.stepCount,
          toolCallCount: run.toolCallCount,
          durationMs: run.durationMs ?? null,
        },
      } as UIMessage['parts'][number])
    }

    messages.push({ id: `${runId}-assistant`, role: 'assistant', parts })
  }
  return messages
}

/** 工具卡的最小结构（AI SDK 的 `dynamic-tool` part；这里只用到这几个字段） */
interface ToolPartLike {
  type: 'dynamic-tool'
  toolName: string
  toolCallId: string
  state: 'input-available' | 'output-available' | 'output-error'
  input?: unknown
  output?: unknown
  errorText?: string
}

/** 工具调用（或只有结果的历史残留）→ 一张卡；结果还没到时 `state` 是 `input-available` */
const toToolPart = (
  call: AgentTimelineItemModel | undefined,
  result: AgentTimelineItemModel | undefined,
): ToolPartLike => {
  const isError = result?.payload?.isError === true
  const output = result?.payload?.output
  return {
    type: 'dynamic-tool',
    toolName: (call?.toolKey ?? result?.toolKey ?? 'tool') as string,
    toolCallId: (call?.toolCallId ??
      result?.toolCallId ??
      `tool-${call?.seq ?? result?.seq ?? 0}`) as string,
    state: result ? (isError ? 'output-error' : 'output-available') : 'input-available',
    input: call?.payload?.input,
    ...(result ? (isError ? { errorText: JSON.stringify(output ?? '') } : { output }) : {}),
  }
}

/** 结果到达：**就地补在这张卡上**（不新建 part —— 卡片的位置必须留在"调用发生的地方"） */
const applyToolResult = (part: ToolPartLike, result: AgentTimelineItemModel): void => {
  const isError = result.payload?.isError === true
  const output = result.payload?.output
  part.state = isError ? 'output-error' : 'output-available'
  if (isError) part.errorText = JSON.stringify(output ?? '')
  else part.output = output
}

/** 子助手的工具结论 → `data-sub-agent` part（与实时流同构）；不是子助手返回 null */
const toSubAgentPart = (
  result: AgentTimelineItemModel,
  toolName: string,
): UIMessage['parts'][number] | null => {
  if (toolName !== 'run-sub-agent') return null
  const outcome = asRecord(result.payload?.output)
  const subRunId = outcome?.subRunId
  if (typeof subRunId !== 'string') return null
  return {
    type: 'data-sub-agent',
    id: subRunId,
    data: { ...outcome, runId: subRunId },
  } as UIMessage['parts'][number]
}

/**
 * 一个 run 的事件 → assistant 消息的 parts。
 *
 * **工具卡按"调用发生的位置"就地铺开**（踩过的坑）：早先工具是攒到最后统一追加的，
 * 于是刷新后历史里的工具卡全被挪到消息末尾（正文在前、工具卡挤在下面），
 * 与实时流（AI SDK 边调边铺）的形态对不上 —— 用户看到的"刷新后工具调用排到后面去了"就是它。
 * 配对靠"先铺卡、结果到达时就地补出参"（对象按引用改，位置不变）。
 */
const toParts = (events: AgentTimelineItemModel[]): UIMessage['parts'] => {
  const parts: UIMessage['parts'] = []
  /** `toolCallId` → 已经铺开的那张卡（结果到达时就地补） */
  const pending = new Map<string, ToolPartLike>()
  // 计划事件单独攒着，最后统一追加（与实时流一致：当前计划渲染在消息末尾）
  const plans: AgentTimelineItemModel[] = []

  for (const item of events) {
    if (item.role === TimelineRole.User) continue
    switch (item.kind) {
      case TimelineKind.Text: {
        const text = textOf(item)
        if (text) parts.push({ type: 'text', text })
        break
      }
      case TimelineKind.Reasoning: {
        const text = textOf(item)
        if (text) parts.push({ type: 'reasoning', text, state: 'done' })
        break
      }
      case TimelineKind.ToolCall: {
        const part = toToolPart(item, undefined)
        parts.push(part as unknown as UIMessage['parts'][number])
        if (item.toolCallId) pending.set(item.toolCallId, part)
        break
      }
      case TimelineKind.ToolResult: {
        const part = item.toolCallId ? pending.get(item.toolCallId) : undefined
        if (part) {
          applyToolResult(part, item)
          const subAgent = toSubAgentPart(item, part.toolName)
          if (subAgent) parts.push(subAgent)
          break
        }
        // 只有结果没有调用（历史残留 / 协议漂移）：也**就地**补一张卡，别挪到末尾
        const orphan = toToolPart(undefined, item)
        parts.push(orphan as unknown as UIMessage['parts'][number])
        const subAgent = toSubAgentPart(item, orphan.toolName)
        if (subAgent) parts.push(subAgent)
        break
      }
      case TimelineKind.Plan: {
        // 计划事件 → `data-plan` part：**payload 原样带上**（计划卡片自己容错解析），
        // 于是历史里的计划与实时流"取最后一次 plan 出参"看到的是同一种结构
        plans.push(item)
        break
      }
      default:
        // 步骤 / 状态 / 摘要 / 错误：审计用，不进对话正文（在审计页看）
        break
    }
  }

  // 计划 part 追加在最后：会话页把"当前计划"渲染在消息末尾，历史与实时因此落在同一个位置。
  // `id` 用 `plan-<seq>` —— 一个 run 里可能有多条计划事件（每次 plan 工具调用一条），id 必须唯一。
  for (const item of plans) {
    parts.push({
      type: 'data-plan',
      id: `plan-${item.seq}`,
      data: item.payload ?? {},
    } as UIMessage['parts'][number])
  }
  return parts
}

/** 从某个子 run 的时间线里抽出它在面板里要展示的片段（推理 / 文本 / 工具事件） */
export interface SubAgentDetail {
  reasoning: string
  text: string
  events: Array<{
    kind: 'tool-call' | 'tool-result'
    toolKey: string | null
    input?: unknown
    output?: unknown
    isError?: boolean
  }>
}

export const toSubAgentDetail = (items: AgentTimelineItemModel[]): SubAgentDetail => {
  const detail: SubAgentDetail = { reasoning: '', text: '', events: [] }
  for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
    if (item.role === TimelineRole.User) continue
    if (item.kind === TimelineKind.Reasoning) {
      detail.reasoning += textOf(item)
    } else if (item.kind === TimelineKind.Text) {
      detail.text += textOf(item)
    } else if (item.kind === TimelineKind.ToolCall) {
      detail.events.push({
        kind: 'tool-call',
        toolKey: item.toolKey,
        input: item.payload?.input,
      })
    } else if (item.kind === TimelineKind.ToolResult) {
      detail.events.push({
        kind: 'tool-result',
        toolKey: item.toolKey,
        output: item.payload?.output,
        isError: item.payload?.isError === true,
      })
    }
  }
  return detail
}
