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
 * 4. 子 agent 的**完整过程**（推理 / 工具往返）不进主对话：它在子 run 的时间线里，
 *    由面板按需拉取（同一套只读接口，见 §3.14.3）。
 */

/** 工具调用与结果的配对键 */
interface ToolPair {
  call?: AgentTimelineItemModel
  result?: AgentTimelineItemModel
}

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

/** 一个 run 的事件 → assistant 消息的 parts */
const toParts = (events: AgentTimelineItemModel[]): UIMessage['parts'] => {
  const parts: UIMessage['parts'] = []
  // 工具调用与结果要配对成一个 part（AI SDK 的工具 part 本身同时带 input 与 output）
  const tools = new Map<string, ToolPair>()
  const order: string[] = []
  // 计划事件单独攒着，最后统一追加（工具 part 是在循环之后才铺开的）
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
      case TimelineKind.ToolCall:
      case TimelineKind.ToolResult: {
        const key = item.toolCallId ?? `${item.kind}-${item.seq}`
        if (!tools.has(key)) order.push(key)
        const pair = tools.get(key) ?? {}
        if (item.kind === TimelineKind.ToolCall) pair.call = item
        else pair.result = item
        tools.set(key, pair)
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

  for (const key of order) {
    const pair = tools.get(key)!
    const call = pair.call
    const result = pair.result
    const toolName =
      (call?.toolKey ?? result?.toolKey ?? 'tool') as string
    const input = call?.payload?.input
    const output = result?.payload?.output
    const isError = result?.payload?.isError === true
    parts.push({
      type: 'dynamic-tool',
      toolName,
      toolCallId: call?.toolCallId ?? result?.toolCallId ?? key,
      state: result ? (isError ? 'output-error' : 'output-available') : 'input-available',
      input,
      ...(result ? (isError ? { errorText: JSON.stringify(output ?? '') } : { output }) : {}),
    } as UIMessage['parts'][number])

    // 子助手：把工具结论合成成 `data-sub-agent` part（与实时流同构）
    if (toolName === 'run-sub-agent') {
      const outcome = asRecord(output)
      const subRunId = outcome?.subRunId
      if (typeof subRunId === 'string') {
        parts.push({
          type: 'data-sub-agent',
          id: subRunId,
          data: { ...outcome, runId: subRunId },
        } as UIMessage['parts'][number])
      }
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
