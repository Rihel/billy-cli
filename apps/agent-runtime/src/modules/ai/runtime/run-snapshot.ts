import {
  agUiEventToChunks,
  createAgUiDecodeState,
  isAgUiEvent,
  type AgentRunSnapshotModel,
  type AgUiChunk,
} from '@repo/shared'
import type { StreamRecord } from './stream-store.service.js'
import { snapshotPartsToChunks } from './message-snapshot.js'

/**
 * 正在跑的那一轮 → 「已闭合内容快照 + 增量起点」。
 *
 * 为什么不整轮重放：实测单轮 15,657 帧 / 1.5MB，切会话 / 刷新一次要重放好几秒；
 * 而且起点落在 part 中间时旧状态机会直接崩（`missing reasoning part`）。
 *
 * 口径（手册 §6.2）：
 * - `parts` 只含**已闭合**的 part（快照归约后 part id 丢了，未闭合部分只能靠增量接回）；
 * - `sinceRev` = 最早未闭合 part 的 start 事件的 rev；没有未闭合 part 时 = 最后一帧 rev + 1；
 * - `rev` = 快照覆盖到的最新 rev（= sinceRev - 1）。
 *
 * 这里**按 chunk 口径归约**：先把事件 decode 成 chunk（工具入参跨事件累积），
 * 再分类成 part —— 与前端 `useChat` 的 parts 形状对齐（文本 / 推理 / `dynamic-tool` / `data-*`）。
 */

/** 一条可以进快照的内容（已闭合） */
type SnapshotEntry =
  | { kind: 'text'; id: string; startRev: number; closeRev: number; text: string }
  | { kind: 'reasoning'; id: string; startRev: number; closeRev: number; text: string }
  | {
      kind: 'tool'
      toolCallId: string
      toolName: string
      startRev: number
      closeRev: number
      input: unknown
      output?: unknown
      isError?: boolean
      errorText?: string
    }
  | { kind: 'chunk'; rev: number; chunk: AgUiChunk }

export interface RunSnapshotResult {
  snapshot: AgentRunSnapshotModel
  /** 快照内容的重放 chunk（保持 part id，前端状态机能原地接上） */
  replayChunks: AgUiChunk[]
}

/** 调用方从 `timelines` 预先归约好的快照（**优先于事件记录**） */
export interface RunSnapshotOptions {
  /** 时间线里这条 assistant 消息的 id（输出记录被裁剪时也不会丢） */
  messageId?: string
  /** 已闭合 part（`buildMessageParts` 的产物） */
  parts?: ReadonlyArray<Record<string, unknown>>
}

interface DecodedChunk {
  rev: number
  chunk: AgUiChunk
}

/** 事件记录 → chunk 序列（新旧两种记录都吃；工具入参状态贯穿整条流） */
export const decodeRecords = (records: readonly StreamRecord[]): DecodedChunk[] => {
  const state = createAgUiDecodeState()
  const out: DecodedChunk[] = []
  for (const record of records) {
    if (isAgUiEvent(record.event)) {
      for (const chunk of agUiEventToChunks(record.event, state)) {
        out.push({ rev: record.rev, chunk })
      }
      continue
    }
    // 旧记录：裸 chunk（TTL 内共存），原样接住
    if (record.event && typeof record.event === 'object') {
      out.push({ rev: record.rev, chunk: record.event as AgUiChunk })
    }
  }
  return out
}

/**
 * 归约出快照与重放内容。
 *
 * `records` 必须按 rev 升序（`readAllEvents` 保证）。
 */
export const buildRunSnapshot = (
  runId: string,
  records: readonly StreamRecord[],
  options: RunSnapshotOptions = {},
): RunSnapshotResult => {
  if (records.length === 0) {
    const parts = options.parts ?? []
    return {
      snapshot: {
        runId,
        messageId: options.messageId ?? '',
        rev: 0,
        sinceRev: 0,
        parts: [...parts],
      },
      replayChunks: options.parts ? snapshotPartsToChunks(options.parts) : [],
    }
  }

  const decoded = decodeRecords(records)
  const lastRev = decoded.at(-1)?.rev ?? 0
  const entries: SnapshotEntry[] = []
  /** 仍在流式中的 part：id → 归约态 */
  const open = new Map<string, OpenPart>()
  let messageId = ''

  const close = (key: string): void => {
    const part = open.get(key)
    if (!part) return
    open.delete(key)
    entries.push(part.entry)
  }

  for (const { rev, chunk } of decoded) {
    switch (chunk.type) {
      case 'start':
        messageId = typeof chunk.messageId === 'string' ? chunk.messageId : messageId
        break
      case 'text-start': {
        const id = String(chunk.id ?? '')
        open.set(`text:${id}`, {
          entry: { kind: 'text', id, startRev: rev, closeRev: rev, text: '' },
          text: '',
          args: '',
        })
        break
      }
      case 'text-delta': {
        const id = String(chunk.id ?? '')
        // 旧记录 / Redis 截断可能没有 `text-start`：补一个打开态，交给 sinceRev 增量去整形补 start
        let part = open.get(`text:${id}`)
        if (!part) {
          part = {
            entry: { kind: 'text', id, startRev: rev, closeRev: rev, text: '' },
            text: '',
            args: '',
          }
          open.set(`text:${id}`, part)
        }
        if (part.entry.kind === 'text') part.text += String(chunk.delta ?? '')
        break
      }
      case 'text-end': {
        const id = String(chunk.id ?? '')
        const part = open.get(`text:${id}`)
        if (!part || part.entry.kind !== 'text') break
        part.entry.text = part.text.trim()
        part.entry.closeRev = rev
        close(`text:${id}`)
        break
      }
      case 'reasoning-start': {
        const id = String(chunk.id ?? '')
        open.set(`reasoning:${id}`, {
          entry: { kind: 'reasoning', id, startRev: rev, closeRev: rev, text: '' },
          text: '',
          args: '',
        })
        break
      }
      case 'reasoning-delta': {
        const id = String(chunk.id ?? '')
        let part = open.get(`reasoning:${id}`)
        if (!part) {
          part = {
            entry: { kind: 'reasoning', id, startRev: rev, closeRev: rev, text: '' },
            text: '',
            args: '',
          }
          open.set(`reasoning:${id}`, part)
        }
        if (part.entry.kind === 'reasoning') part.text += String(chunk.delta ?? '')
        break
      }
      case 'reasoning-end': {
        const id = String(chunk.id ?? '')
        const part = open.get(`reasoning:${id}`)
        if (!part || part.entry.kind !== 'reasoning') break
        part.entry.text = part.text.trim()
        part.entry.closeRev = rev
        close(`reasoning:${id}`)
        break
      }
      case 'tool-input-start': {
        const toolCallId = String(chunk.toolCallId ?? chunk.id ?? '')
        open.set(`tool:${toolCallId}`, {
          entry: {
            kind: 'tool',
            toolCallId,
            toolName: String(chunk.toolName ?? 'unknown'),
            startRev: rev,
            closeRev: rev,
            input: null,
          },
          text: '',
          args: '',
        })
        break
      }
      case 'tool-input-delta': {
        const toolCallId = String(chunk.toolCallId ?? chunk.id ?? '')
        let part = open.get(`tool:${toolCallId}`)
        if (!part) {
          part = {
            entry: {
              kind: 'tool',
              toolCallId,
              toolName: String(chunk.toolName ?? 'unknown'),
              startRev: rev,
              closeRev: rev,
              input: null,
            },
            text: '',
            args: '',
          }
          open.set(`tool:${toolCallId}`, part)
        }
        if (part.entry.kind === 'tool') part.args += String(chunk.inputTextDelta ?? '')
        break
      }
      case 'tool-input-available': {
        const toolCallId = String(chunk.toolCallId ?? chunk.id ?? '')
        const part = open.get(`tool:${toolCallId}`)
        if (!part || part.entry.kind !== 'tool') break
        part.entry.toolName =
          typeof chunk.toolName === 'string' ? chunk.toolName : part.entry.toolName
        part.entry.input = chunk.input ?? safeParse(part.args)
        part.entry.closeRev = rev
        close(`tool:${toolCallId}`)
        break
      }
      case 'tool-output-available':
      case 'tool-output-error': {
        const toolCallId = String(chunk.toolCallId ?? chunk.id ?? '')
        const entry = latestTool(entries, toolCallId)
        if (!entry) break
        entry.closeRev = Math.max(entry.closeRev, rev)
        if (chunk.type === 'tool-output-error') {
          entry.isError = true
          entry.errorText = String(chunk.errorText ?? '工具执行失败')
        } else {
          entry.output = chunk.output
        }
        break
      }
      case 'error':
        entries.push({ kind: 'chunk', rev, chunk })
        break
      case 'finish':
      case '__run_end__':
      case 'start-step':
      case 'finish-step':
      case 'data-run':
        // 运行身份 / 步骤计时不进快照：重放时由调用方补 RUN_STARTED
        break
      default:
        // 其余 `data-*` 业务块：一块就是一份完整内容（stream 模式）或同 id 覆盖（state 模式）
        entries.push({ kind: 'chunk', rev, chunk })
        break
    }
  }

  const openStartRevs = [...open.values()].map((part) => part.entry.startRev)
  const sinceRev = openStartRevs.length > 0 ? Math.min(...openStartRevs) : lastRev + 1

  const closed = entries
    .filter((entry) => entryRev(entry) < sinceRev)
    .sort((a, b) => entryRev(a) - entryRev(b))

  /**
   * `options.parts`（时间线快照）优先：它包含**全部已闭合内容**，不受输出记录裁剪影响。
   * 没有传时才退回事件记录归约（测试 / 极早期空时间线）。
   */
  const parts = options.parts ? [...options.parts] : closed.map(partOf)
  return {
    snapshot: {
      runId,
      messageId: options.messageId || messageId || `run-${runId}-assistant`,
      rev: Math.max(0, sinceRev - 1),
      sinceRev,
      parts: [...parts],
    },
    replayChunks: options.parts ? snapshotPartsToChunks(options.parts) : closed.flatMap(chunksOf),
  }
}

type OpenEntry = Extract<SnapshotEntry, { kind: 'text' | 'reasoning' | 'tool' }>

interface OpenPart {
  entry: OpenEntry
  text: string
  args: string
}

const entryRev = (entry: SnapshotEntry): number =>
  entry.kind === 'chunk' ? entry.rev : entry.startRev

const safeParse = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const latestTool = (
  entries: readonly SnapshotEntry[],
  toolCallId: string,
): Extract<SnapshotEntry, { kind: 'tool' }> | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.kind === 'tool' && entry.toolCallId === toolCallId) return entry
  }
  return null
}

/** 已闭合 part → UIMessage.parts（与 `history.ts` 的渲染口径一致） */
const partOf = (entry: SnapshotEntry): Record<string, unknown> => {
  if (entry.kind === 'text') return { type: 'text', text: entry.text }
  if (entry.kind === 'reasoning') {
    return { type: 'reasoning', text: entry.text, state: 'done' }
  }
  if (entry.kind === 'tool') {
    return {
      type: 'dynamic-tool',
      toolName: entry.toolName,
      toolCallId: entry.toolCallId,
      state: entry.isError
        ? 'output-error'
        : entry.output === undefined
          ? 'input-available'
          : 'output-available',
      input: entry.input,
      ...(entry.isError
        ? { errorText: entry.errorText ?? '' }
        : entry.output !== undefined
          ? { output: entry.output }
          : {}),
    }
  }
  const chunk = entry.chunk
  const data = (chunk as { data?: unknown }).data
  return {
    type: String(chunk.type ?? 'data-unknown'),
    ...(typeof chunk.id === 'string' && chunk.id ? { id: chunk.id } : {}),
    data,
  }
}

/** 已闭合 part → 重放 chunk（保持 part id，前端状态机原地接上） */
const chunksOf = (entry: SnapshotEntry): AgUiChunk[] => {
  if (entry.kind === 'text') {
    return [
      { type: 'text-start', id: entry.id },
      { type: 'text-delta', id: entry.id, delta: entry.text },
      { type: 'text-end', id: entry.id },
    ]
  }
  if (entry.kind === 'reasoning') {
    return [
      { type: 'reasoning-start', id: entry.id },
      { type: 'reasoning-delta', id: entry.id, delta: entry.text },
      { type: 'reasoning-end', id: entry.id },
    ]
  }
  if (entry.kind === 'tool') {
    const args = JSON.stringify(entry.input ?? null)
    return [
      { type: 'tool-input-start', toolCallId: entry.toolCallId, toolName: entry.toolName },
      { type: 'tool-input-delta', toolCallId: entry.toolCallId, inputTextDelta: args },
      {
        type: 'tool-input-available',
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        input: entry.input,
      },
      ...(entry.isError
        ? [
            {
              type: 'tool-output-error',
              toolCallId: entry.toolCallId,
              errorText: entry.errorText ?? '工具执行失败',
            },
          ]
        : entry.output !== undefined
          ? [
              {
                type: 'tool-output-available',
                toolCallId: entry.toolCallId,
                output: entry.output,
              },
            ]
          : []),
    ]
  }
  return [entry.chunk]
}

/** 流式 part 的稳定键（文本 / 推理 / 工具入参）；data-* 与边界块没有"打开态" */
const openKeyOf = (chunk: AgUiChunk): string | null => {
  const id = String(chunk.id ?? chunk.toolCallId ?? '')
  if (!id) return null
  switch (chunk.type) {
    case 'text-start':
    case 'text-delta':
    case 'text-end':
      return `text:${id}`
    case 'reasoning-start':
    case 'reasoning-delta':
    case 'reasoning-end':
      return `reasoning:${id}`
    case 'tool-input-start':
    case 'tool-input-delta':
    case 'tool-input-available':
    case 'tool-input-error':
      return `tool:${id}`
    default:
      return null
  }
}

/**
 * 输出记录被裁剪时，只取**仍未闭合 part** 的 chunk（重连尾部）。
 *
 * 为什么不是直接从 `sinceRev` 切：裁剪后 `sinceRev` 只能取"首条保留记录"（未闭合 part 的
 * 真正 start 可能已被裁掉），而这条记录可能属于某个**已经闭合、已进时间线快照**的 part。
 * 直接把窗口切过去会把已闭合内容再发一遍；这里只挑仍未闭合 part 的增量，交给
 * `resumeSafeChunks` 补一个合成的 start，至少能让后续 delta 接得上。
 */
export const openPartChunks = (records: readonly StreamRecord[]): AgUiChunk[] => {
  const decoded = decodeRecords(records)
  const open = new Set<string>()
  for (const { chunk } of decoded) {
    const key = openKeyOf(chunk)
    if (!key) continue
    const type = String(chunk.type ?? '')
    // start 可能已被裁掉：增量本身也算"这个 part 还开着"，否则会漏掉它
    if (type.endsWith('-start') || type.endsWith('-delta')) open.add(key)
    else if (
      type.endsWith('-end') ||
      type === 'tool-input-available' ||
      type === 'tool-input-error'
    ) {
      open.delete(key)
    }
  }
  return decoded
    .filter(({ chunk }) => {
      const key = openKeyOf(chunk)
      return key !== null && open.has(key)
    })
    .map(({ chunk }) => chunk)
}
