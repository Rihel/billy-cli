'use client'

import {
  getToolName,
  isFileUIPart,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from 'ai'
import { TOOL_EVENT_PART_TYPE, parseToolEventPart } from '@repo/shared'
import type { AgentRunModel, ToolEventPart } from '@repo/shared'
import { createContext, useContext, useSyncExternalStore } from 'react'
import type { MessagePlan } from './plan-panel'
import { collectMessagePlan, isPlanToolName } from './plan-panel'
import type { SuspendedPartData } from './question-card'
import {
  appendSubAgentDelta,
  emptySubAgent,
  isSubAgentActive,
  mergeSubAgentState,
  subRunName,
  withRunState,
  type SubAgentLive,
} from './sub-agent-live'

/**
 * 会话页的**渲染状态**：按 part 的 type 增量维护，而不是每帧把整条消息重新扫一遍。
 *
 * 为什么要有这一层（2026-11-03，会话 vske8ur0le74hwsfii0s 卡死）：原来的渲染直接把
 * `message.parts` 当渲染槽位用 —— 每帧要扫 4–6 遍 parts、再生成同样长度的 children 数组。
 * 而一条消息的 parts 里绝大多数是**数据块**（子助手增量、状态、用量…），真正的渲染单元
 * （文本 / 推理 / 工具卡 / 子助手卡 / 计划卡）只有几十个。两者同构 = 每帧成本随流长度线性涨。
 *
 * 这一层做的事很朴素（就是"按 type 追加 / 更新"）：
 * - **写**：新 part 到了 → 按 type 归约进 `units`；流式文本/工具结果这类"同一下标就地更新"的，
 *   按下标覆盖；子助手增量**折叠进聚合正文**，不产生新单元。
 * - **读**：组件只吃 `units`，不再回头扫 parts。
 *
 * 归约是**幂等**的：同一 part 下标重复归约只会覆盖（文本/推理/工具）或跳过（增量），
 * 所以"从上一项重放一遍尾部"（流式 part 原位更新）不会造成重复内容。
 */

/** 附件信息（渲染时才拼可访问地址：`useStorageAdapter` 在组件里） */
export interface ChatAttachmentInfo {
  key?: string
  filename?: string
  mediaType?: string
  url?: string
  bytes?: number
}

/**
 * 子 agent 完成唤醒的系统卡（时间线 `status=subagent_completed` 与实时块同一形状）。
 *
 * 它表达的是"父这一轮为什么又开始了"：不是用户说话，是子助手交了结论。
 */
export interface SubAgentCompletedData {
  status: string
  subAgentId: string
  subRunId: string
  name: string
  childStatus: string
  summary: string | null
  error: string | null
  childConversationId?: string
}

/** 工具单元里的 part 形状（历史与实时都收敛成这一种） */
export interface ChatToolPartLike {
  type: 'dynamic-tool'
  toolName: string
  toolCallId: string
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
  input?: unknown
  output?: unknown
  errorText?: string
  durationMs?: number
}

/** 一个**渲染单元** = 界面上一个可见块 */
export type ChatUnit =
  | { kind: 'text'; key: string; index: number; text: string; streaming: boolean }
  | {
      kind: 'reasoning'
      key: string
      index: number
      text: string
      streaming: boolean
      durationMs?: number
    }
  | {
      kind: 'tool'
      key: string
      index: number
      part: ChatToolPartLike
      /** 这次调用发出的事件（`data-tool-event`，按 toolCallId 归组） */
      events: ToolEventPart[]
      /** 委派类（`run-sub-agent`）：由子助手卡代表，原始卡不画 */
      delegated: boolean
      /** 问题工具：由问答卡代表，只有报错时才露原始卡 */
      hidden: boolean
    }
  | { kind: 'question'; key: string; index: number; data: SuspendedPartData }
  | {
      kind: 'sub-agent'
      key: string
      index: number
      runId: string
      snapshot: SubAgentLive
      /** 已经折叠到聚合正文的最后一个 delta 下标（保证重放不重复追加） */
      lastDeltaIndex: number
    }
  | { kind: 'summary'; key: string; index: number; text: string; covers: string }
  | { kind: 'notice'; key: string; index: number; data: SubAgentCompletedData }
  | { kind: 'event'; key: string; index: number; part: ToolEventPart }
  | { kind: 'unknown'; key: string; index: number; partType: string }

/** 一条消息的渲染状态 */
export interface ChatMessageState {
  id: string
  role: 'user' | 'assistant'
  units: ChatUnit[]
  files: ChatAttachmentInfo[]
  plan: MessagePlan | null
  usage: Record<string, unknown> | null
  /** 事件 part 的归组结果（`toolCallId` → 事件；渲染工具卡时取） */
  eventsByCall: Map<string, ToolEventPart[]>
  /** 已经归约到 parts 的第几项（增量游标；流式时从最后一项重放） */
  applied: number
  /** 原始消息（复制按钮要按 parts 序列化，渲染路径不使用） */
  source: UIMessage
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null

const attachmentInfoOf = (part: unknown): ChatAttachmentInfo | null => {
  const record = asRecord(part)
  if (!record) return null
  const key = typeof record.attachmentKey === 'string' ? record.attachmentKey : undefined
  const url = typeof record.url === 'string' ? record.url : undefined
  if (!key && !url) return null
  return {
    ...(key ? { key } : {}),
    ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
    ...(typeof record.mediaType === 'string' ? { mediaType: record.mediaType } : {}),
    ...(url ? { url } : {}),
    ...(typeof record.attachmentBytes === 'number' ? { bytes: record.attachmentBytes } : {}),
  }
}

const durationOf = (part: unknown): number | undefined => {
  const value = (part as { durationMs?: unknown }).durationMs
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 工具 part → 我们自己的形状（历史与实时同一个形状，渲染层不必分支） */
const toToolPart = (part: unknown): ChatToolPartLike | null => {
  if (!isToolUIPart(part as never)) return null
  const record = part as Record<string, unknown>
  const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : ''
  if (!toolCallId) return null
  return {
    type: 'dynamic-tool',
    toolName: getToolName(part as never),
    toolCallId,
    state: (record.state as ChatToolPartLike['state']) ?? 'input-available',
    input: record.input,
    output: record.output,
    ...(typeof record.errorText === 'string' ? { errorText: record.errorText } : {}),
    ...(durationOf(part) !== undefined ? { durationMs: durationOf(part) } : {}),
  }
}

/** 空的消息状态（历史与实时都从这里起手） */
export const createMessageState = (message: UIMessage): ChatMessageState => ({
  id: message.id,
  role: message.role === 'user' ? 'user' : 'assistant',
  units: [],
  files: [],
  plan: null,
  usage: null,
  eventsByCall: new Map(),
  applied: 0,
  source: message,
})

const replaceUnit = (units: ChatUnit[], key: string, next: ChatUnit): ChatUnit[] => {
  const index = units.findIndex((unit) => unit.key === key)
  if (index < 0) return [...units, next]
  const copy = units.slice()
  copy[index] = next
  return copy
}

const findUnit = (units: ChatUnit[], key: string): ChatUnit | undefined =>
  units.find((unit) => unit.key === key)

/**
 * 归约一个 part。返回新的 `units`（只有真的变了才返回新数组）。
 *
 * 幂等是关键：流式 part 会被重复归约（尾部重放），所以文本/推理/工具是"覆盖"语义，
 * 只有增量块在**下标前进时**才追加。
 */
const applyPart = (
  state: ChatMessageState,
  message: UIMessage,
  index: number,
): Partial<ChatMessageState> | null => {
  const part = message.parts[index]
  if (!part) return null

  if (isFileUIPart(part)) {
    const info = attachmentInfoOf(part)
    if (!info) return null
    const exists = state.files.some(
      (file) => (info.key && file.key === info.key) || (info.url && file.url === info.url),
    )
    return exists ? null : { files: [...state.files, info] }
  }

  if (isTextUIPart(part)) {
    const key = `text-${index}`
    const next = {
      kind: 'text' as const,
      key,
      index,
      text: part.text,
      streaming: part.state === 'streaming',
    }
    const existing = findUnit(state.units, key)
    if (
      existing &&
      existing.kind === 'text' &&
      existing.text === next.text &&
      existing.streaming === next.streaming
    ) {
      return null
    }
    return { units: replaceUnit(state.units, key, next) }
  }

  if (isReasoningUIPart(part)) {
    const key = `reasoning-${index}`
    const existing = findUnit(state.units, key)
    const next = {
      kind: 'reasoning' as const,
      key,
      index,
      text: part.text,
      streaming: part.state === 'streaming',
      ...(durationOf(part) !== undefined ? { durationMs: durationOf(part) } : {}),
    }
    if (
      existing &&
      existing.kind === 'reasoning' &&
      existing.text === next.text &&
      existing.streaming === next.streaming
    ) {
      return null
    }
    return { units: replaceUnit(state.units, key, next) }
  }

  if (isToolUIPart(part)) {
    const toolPart = toToolPart(part)
    if (!toolPart) return null
    /**
     * `wait-task` 按 **taskId** 合并（协议 §10.2）：同一个长任务会被轮询好几次，
     * 每次都出新卡会把会话刷成日志流；这里只保留最后一张（快照本身就是最新状态）。
     *
     * 输入还没到（input-streaming）时先按 toolCallId 建占位卡，拿到 taskId 后把占位卡摘掉。
     */
    const taskId = toolPart.toolName === 'wait-task' ? asRecord(toolPart.input)?.taskId : undefined
    const mergeKey =
      typeof taskId === 'string' && taskId ? `wait-task-${taskId}` : `tool-${toolPart.toolCallId}`
    const placeholderKey = `tool-${toolPart.toolCallId}`
    const units =
      mergeKey === placeholderKey
        ? state.units
        : state.units.filter((unit) => unit.key !== placeholderKey)
    // 计划工具由消息末尾的计划卡代表；问题工具由问答卡代表（只有报错时才露原始卡）
    const hidden =
      isPlanToolName(toolPart.toolName) ||
      (toolPart.toolName === 'ask-user-questions' && toolPart.state !== 'output-error')
    const existing = findUnit(units, mergeKey)
    const delegated = existing && existing.kind === 'tool' ? existing.delegated : false
    const events = state.eventsByCall.get(toolPart.toolCallId) ?? []
    return {
      units: replaceUnit(units, mergeKey, {
        kind: 'tool',
        key: mergeKey,
        index,
        part: toolPart,
        events,
        delegated,
        hidden,
      }),
    }
  }

  switch (part.type) {
    case 'data-sub-agent': {
      const data = asRecord((part as { data?: unknown }).data)
      if (!data) return null
      const runId = typeof data.runId === 'string' ? data.runId : (part as { id?: string }).id
      if (!runId) return null
      const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined
      const key = `sub-agent-${runId}`
      const existing = findUnit(state.units, key)
      const snapshot =
        existing && existing.kind === 'sub-agent' ? { ...existing.snapshot } : emptySubAgent(runId)
      mergeSubAgentState(snapshot, data)
      const lastDeltaIndex =
        existing && existing.kind === 'sub-agent' ? existing.lastDeltaIndex : -1
      let units = replaceUnit(state.units, key, {
        kind: 'sub-agent',
        key,
        index: existing?.index ?? index,
        runId,
        snapshot,
        lastDeltaIndex,
      })
      // 委派类工具调用：把对应的原始工具卡吃掉（同一件事只画一张卡）
      if (toolCallId) {
        const toolKey = `tool-${toolCallId}`
        const tool = findUnit(units, toolKey)
        if (tool && tool.kind === 'tool' && !tool.delegated) {
          units = replaceUnit(units, toolKey, { ...tool, delegated: true })
        }
      }
      return { units }
    }
    case 'data-sub-agent-delta': {
      const data = asRecord((part as { data?: unknown }).data)
      if (!data) return null
      const runId = typeof data.runId === 'string' ? data.runId : ''
      if (!runId) return null
      const key = `sub-agent-${runId}`
      const existing = findUnit(state.units, key)
      // 幂等：同一 part 下标被重放时不重复追加
      if (existing && existing.kind === 'sub-agent' && existing.lastDeltaIndex >= index) return null
      const snapshot =
        existing && existing.kind === 'sub-agent'
          ? { ...existing.snapshot }
          : emptySubAgent(runId, typeof data.name === 'string' ? data.name : undefined)
      appendSubAgentDelta(
        snapshot,
        data.kind === 'reasoning' ? 'reasoning' : 'text',
        typeof data.text === 'string' ? data.text : '',
      )
      return {
        units: replaceUnit(state.units, key, {
          kind: 'sub-agent',
          key,
          index: existing?.index ?? index,
          runId,
          snapshot,
          lastDeltaIndex: index,
        }),
      }
    }
    case 'data-summary': {
      const data = asRecord((part as { data?: unknown }).data)
      const text = typeof data?.text === 'string' ? data.text : ''
      if (!text) return null
      const key = `summary-${index}`
      return {
        units: replaceUnit(state.units, key, {
          kind: 'summary',
          key,
          index,
          text,
          covers: typeof data?.covers === 'string' ? data.covers : '',
        }),
      }
    }
    case 'data-subagent-completed': {
      // 子 agent 完成唤醒的系统卡：历史（时间线 status）与实时块同形状，按 subRunId 归并
      const data = asRecord((part as { data?: unknown }).data)
      if (!data || typeof data.name !== 'string') return null
      const subRunId = typeof data.subRunId === 'string' ? data.subRunId : `notice-${index}`
      const key = `notice-${subRunId}`
      return {
        units: replaceUnit(state.units, key, {
          kind: 'notice',
          key,
          index,
          data: data as unknown as SubAgentCompletedData,
        }),
      }
    }
    case 'data-queue':
      // 排队应答只用于提示（会话页横幅），不是消息内容；不生成"未识别片段"卡
      return null
    case 'data-plan':
      // 计划由 `collectMessagePlan` 统一算（工具出参与计划事件两处来源），这里只标记需要重算
      return { plan: collectMessagePlan(message.parts) }
    // 轮内实时（`data-step-usage`，每步一条）与收尾（`data-run-usage`，一次）**同一个形状**：
    // 只更新消息上的用量，不产生渲染单元（认成未知 part 会多出一张"未识别片段"卡）
    case 'data-run-usage':
    case 'data-step-usage': {
      const data = asRecord((part as { data?: unknown }).data)
      return data ? { usage: data.usage ? asRecord(data.usage) : state.usage } : null
    }
    case 'data-tool-call-suspended': {
      const data = (part as { data?: SuspendedPartData }).data
      if (!data) return null
      const key = `question-${data.toolCallId ?? index}`
      return {
        units: replaceUnit(state.units, key, { kind: 'question', key, index, data }),
      }
    }
    case TOOL_EVENT_PART_TYPE: {
      const event = parseToolEventPart(part)
      if (!event) {
        const key = `unknown-${index}`
        return {
          units: replaceUnit(state.units, key, {
            kind: 'unknown',
            key,
            index,
            partType: TOOL_EVENT_PART_TYPE,
          }),
        }
      }
      const toolCallId = event.data.toolCallId
      // 有主的（能对上工具卡）进归组表；无主的独立成卡
      if (toolCallId) {
        const bucket = state.eventsByCall.get(toolCallId) ?? []
        const eventsByCall = new Map(state.eventsByCall)
        eventsByCall.set(toolCallId, [...bucket, event])
        const toolKey = `tool-${toolCallId}`
        const tool = findUnit(state.units, toolKey)
        if (tool && tool.kind === 'tool') {
          return {
            eventsByCall,
            units: replaceUnit(state.units, toolKey, { ...tool, events: [...bucket, event] }),
          }
        }
        // 消息里还没有对应工具卡（子 agent 内部工具发的 / 非流式调用）：先独立成卡；
        // 若之后真的出现了同 id 的工具卡，渲染层按"已被认领"跳过，避免出现两张卡。
        const key = `event-${index}`
        return {
          eventsByCall,
          units: replaceUnit(state.units, key, { kind: 'event', key, index, part: event }),
        }
      }
      const key = `event-${index}`
      return { units: replaceUnit(state.units, key, { kind: 'event', key, index, part: event }) }
    }
    case 'step-start':
    case 'data-run':
    case 'data-run-suspended':
    case 'data-conversation-title':
      return null
    default:
      return {
        units: replaceUnit(state.units, `unknown-${index}`, {
          kind: 'unknown',
          key: `unknown-${index}`,
          index,
          partType: (part as { type: string }).type,
        }),
      }
  }
}

/**
 * 把一条消息从 `from` 号 part 起归约到 `state`。返回新的状态对象（没变化就返回原对象，
 * 以便 `React.memo` 跳过整行）。
 */
const reduceMessage = (
  state: ChatMessageState,
  message: UIMessage,
  from: number,
): ChatMessageState => {
  let units = state.units
  let files = state.files
  let plan = state.plan
  let usage = state.usage
  let eventsByCall = state.eventsByCall
  let changed = false

  for (let index = Math.max(0, from); index < message.parts.length; index += 1) {
    const patch = applyPart({ ...state, units, files, plan, usage, eventsByCall }, message, index)
    if (!patch) continue
    changed = true
    if (patch.units) units = patch.units
    if (patch.files) files = patch.files
    if (patch.plan !== undefined) plan = patch.plan
    if (patch.usage !== undefined) usage = patch.usage
    if (patch.eventsByCall) eventsByCall = patch.eventsByCall
  }

  /**
   * 原始消息的引用**原地更新**（复制按钮按 parts 序列化时才读它）：
   * 不为此新建状态对象 —— 否则每一帧都是"新消息对象"，`memo` 的行级跳过会全部失效。
   */
  state.source = message
  // 只有内容真的变了才换对象：这一条是行级 memo 能不能生效的前提
  if (!changed) return state
  return {
    ...state,
    units,
    files,
    plan,
    usage,
    eventsByCall,
    applied: message.parts.length,
  }
}

/**
 * 一条消息 → 渲染状态（纯函数）。
 *
 * 子 agent tab 的"完整过程"用的就是这一份：历史消息（`UIMessage`）进来，归约成与主对话
 * 完全相同的单元结构，再用同一个 `ChatMessage` 渲染 —— 两处不会各写一套映射。
 */
export const toMessageState = (message: UIMessage): ChatMessageState =>
  reduceMessage(createMessageState(message), message, 0)

/** 会话快照（`useSyncExternalStore` 的读模型；只在发布时新建） */
export interface ChatSessionSnapshot {
  version: number
  messages: ChatMessageState[]
  live: SubAgentLive[]
  liveById: Map<string, SubAgentLive>
}

/** 实时数据的合并窗口（毫秒）：数据到达不直接进 React，一窗合并一次 */
const LIVE_FLUSH_MS = 100

/**
 * 一个会话的渲染状态 + 实时过程。
 *
 * 两个写入入口，职责分开：
 * - `sync(messages)`：useChat 的消息数组（历史 / 流式 part）→ 增量归约成 `messages`；
 * - `applyChunk(chunk)`：`onData` 的 data 块（子助手状态 / 增量 / 运行身份）→ 实时数据。
 *
 * 读入口只有 `getSnapshot()` + 订阅；React 侧通过 `useSyncExternalStore` 消费。
 */
export class ChatSessionStore {
  private states = new Map<string, ChatMessageState>()
  /** 每条消息上次同步时的 parts（引用快照）：用来定位"第一个变了的 part" */
  private syncedParts = new Map<string, readonly unknown[]>()
  private order: string[] = []
  private live = new Map<string, SubAgentLive>()
  /**
   * 子 run 的**库内状态**（会话页 `run/list` 喂进来；只收子 run）。
   *
   * 为什么不并进 `live`：`live` 会被新一轮的 `beginRun` 清空（防止重放时正文翻倍），
   * 而"这个子助手早就跑完了"是**跨轮成立**的事实 —— 清掉就会退回起跑快照（进行中 0 步）。
   */
  private runStates = new Map<string, AgentRunModel>()
  private listeners = new Set<() => void>()
  private snapshot: ChatSessionSnapshot = {
    version: 0,
    messages: [],
    live: [],
    liveById: new Map(),
  }
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private pending = false

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ChatSessionSnapshot => this.snapshot

  /** useChat 的消息数组 → 增量归约（只处理新 part / 原位更新的尾部） */
  sync(messages: readonly UIMessage[]): void {
    let changed = false
    const order: string[] = []

    for (const message of messages) {
      order.push(message.id)
      const parts = message.parts
      const previous = this.syncedParts.get(message.id)
      const existing = this.states.get(message.id)
      if (!existing) {
        const next = reduceMessage(createMessageState(message), message, 0)
        this.states.set(message.id, next)
        this.syncedParts.set(message.id, parts)
        changed = true
        continue
      }
      if (previous && parts.length < previous.length) {
        // 续传重放 / 消息被替换：parts 从 0 重来 → 整条重建，避免残留旧内容
        const next = reduceMessage(createMessageState(message), message, 0)
        this.states.set(message.id, next)
        this.syncedParts.set(message.id, parts)
        changed = true
        continue
      }
      /**
       * 从**第一个引用变了的 part**起重放（而不是死认最后一项）。
       *
       * 流式文本 / 推理 / 工具结果都是尾部原地更新，扫描到尾部就命中，成本与增量成正比；
       * 但"问题卡被标成已回答""计划被合并"这类改写发生在**消息中间** ——
       * 只从 `applied - 1` 重放的话，中间那一段永远同步不到渲染状态
       * （表现：答案提交了，dock 上的问题卡却一直挂着）。
       */
      const limit = previous ? Math.min(previous.length, parts.length) : parts.length
      let from = limit
      if (previous) {
        for (let index = 0; index < limit; index += 1) {
          if (previous[index] !== parts[index]) {
            from = index
            break
          }
        }
      }
      const next = reduceMessage(existing, message, from)
      this.syncedParts.set(message.id, parts)
      if (next !== existing) {
        this.states.set(message.id, next)
        changed = true
      }
    }

    if (this.order.length !== order.length || this.order.some((id, i) => id !== order[i])) {
      this.order = order
      changed = true
    }
    // 已不在列表里的消息要清掉（删除会话消息 / 换会话残留）
    if (this.states.size > order.length) {
      const alive = new Set(order)
      for (const id of this.states.keys()) {
        if (!alive.has(id)) {
          this.states.delete(id)
          this.syncedParts.delete(id)
        }
      }
    }
    if (changed) this.publish()
  }

  /**
   * `onData` 的 data 块 → 实时数据。
   *
   * - `data-run`：新的一轮（或续传重放）开始 → 清掉上一轮的实时数据，避免重放时正文翻倍；
   * - `data-sub-agent` / `data-sub-agent-delta`：状态与增量合并进聚合对象。
   */
  applyChunk(chunk: { type: string; id?: string; data?: unknown }): void {
    if (chunk.type === 'data-run') {
      const data = asRecord(chunk.data)
      const runId = typeof data?.runId === 'string' ? data.runId : undefined
      if (runId) this.beginRun(runId)
      return
    }
    if (chunk.type !== 'data-sub-agent' && chunk.type !== 'data-sub-agent-delta') return

    const data = asRecord(chunk.data)
    if (!data) return
    const runId = typeof data.runId === 'string' ? data.runId : chunk.id
    if (!runId) return
    const existing = this.live.get(runId)
    const next: SubAgentLive = existing
      ? { ...existing, events: [...existing.events] }
      : emptySubAgent(runId)
    if (chunk.type === 'data-sub-agent') {
      mergeSubAgentState(next, data)
    } else {
      appendSubAgentDelta(
        next,
        data.kind === 'reasoning' ? 'reasoning' : 'text',
        typeof data.text === 'string' ? data.text : '',
      )
    }
    this.live.set(runId, next)
    this.scheduleFlush()
  }

  /** 新的一轮开始：实时数据清空（同一会话的上一轮不该混进来；续传重放也从这里重来） */
  beginRun(_runId: string): void {
    if (this.live.size === 0) return
    this.live.clear()
    this.scheduleFlush()
  }

  /**
   * 同步子 run 的库内状态（`run/list` 到达时调用）。
   *
   * 存在的理由：实时块只在父这一轮的流还开着、且本轮还没被 `beginRun` 清空时才收得到。
   * 父流一关（子助手常常比父晚结束）或子助手完成触发唤醒轮，卡片就只能靠历史 part 的
   * "起跑快照"（status=running、计数 0）。库里的子 run 行是终态权威，存下来给视图合并。
   *
   * 只收子 run（`parentRunId !== null`）：根 run 是主会话自己，不归子助手卡管。
   * 状态没变就不 publish（`run/list` 4s 一轮，避免无意义重渲染）。
   */
  applyRunStates(runs: readonly AgentRunModel[]): void {
    let changed = false
    for (const run of runs) {
      if (run.parentRunId === null) continue
      const previous = this.runStates.get(run.id)
      if (
        previous &&
        previous.status === run.status &&
        previous.stepCount === run.stepCount &&
        previous.toolCallCount === run.toolCallCount &&
        previous.durationMs === run.durationMs
      ) {
        continue
      }
      this.runStates.set(run.id, run)
      changed = true
    }
    if (changed) this.publish()
  }

  /** 当前这一轮的子助手是否还有在跑的（运行指示与用例用；tab 条按单个 run 判活跃态） */
  hasActiveSubAgent(): boolean {
    for (const live of this.views().values()) {
      if (isSubAgentActive(live)) return true
    }
    return false
  }

  activeSubAgentName(): string | null {
    for (const live of this.views().values()) {
      if (isSubAgentActive(live)) return live.name
    }
    return null
  }

  /** 实时数据一窗合并一次通知（增量块每秒上百个，逐个 setState 会拖死主线程） */
  private scheduleFlush(): void {
    if (this.flushTimer) {
      this.pending = true
      return
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (this.pending) this.pending = false
      this.publish()
    }, LIVE_FLUSH_MS)
  }

  private publish(): void {
    const messages = this.order
      .map((id) => this.states.get(id))
      .filter((state): state is ChatMessageState => Boolean(state))
    const liveById = this.views()
    this.snapshot = {
      version: this.snapshot.version + 1,
      messages,
      live: [...liveById.values()],
      liveById,
    }
    for (const listener of this.listeners) listener()
  }

  /**
   * 子助手视图 = 「实时快照 ← 库内 run 终态」。
   *
   * 两类条目都要有：
   * - 实时里有、库里还没到（刚起跑）→ 直接给实时那份；
   * - 库里有、实时里已经没有（刷新首屏 / 唤醒轮清空之后）→ 用 run 合成一份，
   *   否则卡片会退回历史 part 的"进行中 0 步"。
   */
  private views(): Map<string, SubAgentLive> {
    const views = new Map<string, SubAgentLive>()
    for (const [runId, live] of this.live) {
      const run = this.runStates.get(runId)
      views.set(runId, run ? withRunState(live, run) : live)
    }
    for (const [runId, run] of this.runStates) {
      if (views.has(runId)) continue
      views.set(runId, withRunState(emptySubAgent(runId, subRunName(run.agentKey)), run))
    }
    return views
  }
}

/** 会话页用 React 上下文把 store 传给子树（卡片各自订阅，避免整个列表跟着实时数据重渲染） */
export const ChatSessionStoreContext = createContext<ChatSessionStore | null>(null)

export function useChatSessionStore(): ChatSessionStore {
  const store = useContext(ChatSessionStoreContext)
  if (!store) throw new Error('会话 store 缺失：ChatSessionStoreContext 未挂载')
  return store
}

/** 会话渲染状态（消息列表）。流式期间每次 SDK 提交最多一次，成本 O(变化的消息) */
export function useChatMessages(): ChatMessageState[] {
  const store = useChatSessionStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).messages
}

/** 本轮子助手的实时过程（一窗 100ms 合并一次通知） */
export function useLiveSubAgents(): SubAgentLive[] {
  const store = useChatSessionStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).live
}

/** 单个子助手（子助手卡片各自订阅：只有它自己变形时才重渲染） */
export function useLiveSubAgent(runId?: string | null): SubAgentLive | undefined {
  const store = useChatSessionStore()
  return useSyncExternalStore(
    store.subscribe,
    () => (runId ? store.getSnapshot().liveById.get(runId) : undefined),
    () => undefined,
  )
}

/** 正在跑的那个子助手的名字（运行指示用） */
export function useActiveSubAgentName(): string | null {
  const store = useChatSessionStore()
  return useSyncExternalStore(
    store.subscribe,
    () => store.activeSubAgentName(),
    () => null,
  )
}
