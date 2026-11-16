import { EventType } from '@ag-ui/core'
import { AGUI_CUSTOM } from './agui.constant.js'
import type { AgUiChunk, AgUiEncodeContext, AgUiEvent } from './agui.types.js'

/** 工具入参常是半截 JSON：能解析就解析，不能就原样返回（不要把解码流程打断） */
export const safeJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

/** CUSTOM 事件构造器（名字统一从 `AGUI_CUSTOM` 取） */
const custom = (name: string, value: unknown, timestamp: number): AgUiEvent =>
  ({ type: EventType.CUSTOM, name, value, timestamp }) as AgUiEvent

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * 内部 chunk → AG-UI 事件（**唯一编码入口**）。
 *
 * 只做协议映射，不碰存储 / 广播：调用方（执行服务）负责把返回的事件逐条写进
 * 输出记录并广播 —— 于是"存的就是事件、传的也是事件"，网关只透传。
 *
 * 认不出的块不丢：包成 `RAW`（协议留给"未建模细节"的口子），将来加新块不必改协议。
 */
export const encodeAgUiChunk = (chunk: AgUiChunk, ctx: AgUiEncodeContext): AgUiEvent[] => {
  const type = String(chunk?.type ?? '')
  const id = String(chunk.id ?? '')
  const toolCallId = String(chunk.toolCallId ?? '') || id
  const ts = Date.now()

  switch (type) {
    // ── 运行边界 ────────────────────────────────────────────────
    case 'data-run': {
      const data = asRecord(chunk.data)
      return [
        {
          type: EventType.RUN_STARTED,
          threadId: String(data?.conversationId ?? ctx.threadId),
          runId: String(data?.runId ?? ctx.runId),
          protocolVersion: '1.0',
          timestamp: ts,
        },
      ]
    }

    // ── 文本 / 推理：messageId 用 part id ──────────────────────
    case 'text-start':
      return [
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: id,
          role: 'assistant',
          timestamp: ts,
        },
      ]
    case 'text-delta':
      return [
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: id,
          delta: String(chunk.delta ?? ''),
          timestamp: ts,
        },
      ]
    case 'text-end':
      return [{ type: EventType.TEXT_MESSAGE_END, messageId: id, timestamp: ts }]

    case 'reasoning-start':
      return [
        {
          type: EventType.REASONING_MESSAGE_START,
          messageId: id,
          role: 'reasoning',
          timestamp: ts,
        },
      ]
    case 'reasoning-delta':
      return [
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: id,
          delta: String(chunk.delta ?? ''),
          timestamp: ts,
        },
      ]
    case 'reasoning-end':
      return [{ type: EventType.REASONING_MESSAGE_END, messageId: id, timestamp: ts }]

    // ── 工具：`TOOL_CALL_END` 不带入参，入参靠 ARGS 累积 ──────
    case 'tool-input-start':
      return [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: String(chunk.toolName ?? 'unknown'),
          ...(ctx.messageId ? { parentMessageId: ctx.messageId } : {}),
          timestamp: ts,
        },
      ]
    case 'tool-input-delta':
      return [
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: String(chunk.inputTextDelta ?? ''),
          timestamp: ts,
        },
      ]
    case 'tool-input-available':
      return [{ type: EventType.TOOL_CALL_END, toolCallId, timestamp: ts }]
    case 'tool-input-error':
      return [
        {
          type: EventType.TOOL_CALL_END,
          toolCallId,
          // 协议本身没有"入参错误"，用 metadata 保留语义（否则前端会把失败画成正常结束）
          metadata: { inputError: true, errorText: String(chunk.errorText ?? '') },
          timestamp: ts,
        },
      ]

    case 'tool-output-available':
      return [
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: ctx.messageId ?? toolCallId,
          toolCallId,
          content: JSON.stringify(chunk.output ?? null),
          role: 'tool',
          timestamp: ts,
        },
      ]
    case 'tool-output-error':
      return [
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: ctx.messageId ?? toolCallId,
          toolCallId,
          content: String(chunk.errorText ?? '工具执行失败'),
          role: 'tool',
          metadata: { isError: true },
          timestamp: ts,
        },
      ]

    // ── 业务扩展：带 id 的用 `{ id?, data }` 信封 ─────────────
    case 'data-plan':
      return [custom(AGUI_CUSTOM.plan, chunk.data, ts)]

    case 'data-sub-agent':
    case 'data-sub-agent-delta':
    case 'data-subagent-completed': {
      const data = asRecord(chunk.data)
      const cardId = id || (typeof data?.subRunId === 'string' ? data.subRunId : '')
      return [
        custom(
          AGUI_CUSTOM.subAgent,
          { kind: type, ...(cardId ? { id: cardId } : {}), data: chunk.data },
          ts,
        ),
      ]
    }

    case 'data-tool-event':
      return [custom(AGUI_CUSTOM.toolEvent, { ...(id ? { id } : {}), data: chunk.data }, ts)]

    case 'data-tool-call-suspended': {
      const data = asRecord(chunk.data)
      const cardId = id || (typeof data?.toolCallId === 'string' ? data.toolCallId : '')
      return [
        custom(AGUI_CUSTOM.suspended, { ...(cardId ? { id: cardId } : {}), data: chunk.data }, ts),
      ]
    }

    case 'data-run-suspended':
      return [custom(AGUI_CUSTOM.runSuspended, chunk.data, ts)]

    case 'data-queue':
      return [custom(AGUI_CUSTOM.queue, chunk.data, ts)]

    case 'data-step-usage':
    case 'data-run-usage':
      return [custom(AGUI_CUSTOM.usage, { kind: type, data: chunk.data }, ts)]

    case 'data-conversation-title':
      return [custom(AGUI_CUSTOM.title, chunk.data, ts)]

    case 'data-status':
      return [custom(AGUI_CUSTOM.status, chunk.data, ts)]

    case 'data-summary':
      return [custom(AGUI_CUSTOM.summary, { ...(id ? { id } : {}), data: chunk.data }, ts)]

    // ── 消息头（AG-UI 没有消息级 start，用 CUSTOM 显式给）──
    case 'start': {
      const messageId = String(chunk.messageId ?? '') || ctx.messageId || ''
      return [custom(AGUI_CUSTOM.message, { messageId }, ts)]
    }

    // ── 收尾 ────────────────────────────────────────────────────
    case 'error':
      return [
        {
          type: EventType.RUN_ERROR,
          message: String(chunk.errorText ?? '运行失败'),
          timestamp: ts,
        },
      ]
    case '__run_end__':
      return [
        {
          type: EventType.RUN_FINISHED,
          threadId: ctx.threadId,
          runId: ctx.runId,
          timestamp: ts,
        },
      ]
    /**
     * AI SDK 的 `finish` 是**一条消息**的结束，不是**一次运行**的边界 ——
     * 收尾的标题 / 用量还在它后面。映射成 `RUN_FINISHED` 会让 main 提前 `end()`，
     * 后面的事件全丢（e2e 上表现为 RUN_FINISHED 出现在 title 之前）。
     * 真正的运行边界是 `__run_end__`；客户端需要的 `finish` 由解码器从 `RUN_FINISHED` 还原。
     */
    case 'finish':
      return [{ type: EventType.RAW, event: chunk, timestamp: ts }]

    // 认不出的帧别丢：RAW 是协议留给"未建模细节"的口子
    default:
      return [{ type: EventType.RAW, event: chunk, timestamp: ts }]
  }
}
