import { EventType } from '@ag-ui/core'
import { AGUI_CUSTOM } from './agui.constant.js'
import { safeJson } from './agui.encode.js'
import {
  createAgUiDecodeState,
  type AgUiChunk,
  type AgUiDecodeState,
  type AgUiEvent,
} from './agui.types.js'

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * AG-UI 事件 → 内部 chunk（**只为两件事存在**）。
 *
 * 1. 回退口：老前端 / 脚本只认 chunk，网关出口用 `?protocol=ai` 逆映射；
 * 2. 补发整形：先把事件还原成 chunk，再套用既有的"回退到块开头 / 丢孤立 end"算法。
 *
 * `state` 必须**贯穿整条流**（工具入参靠 ARGS 累积），不能每条事件新建一份。
 */
export const agUiEventToChunks = (
  event: AgUiEvent,
  state: AgUiDecodeState = createAgUiDecodeState(),
): AgUiChunk[] => {
  switch (event.type) {
    case EventType.RUN_STARTED:
      return [
        {
          type: 'data-run',
          data: { runId: event.runId, conversationId: event.threadId },
        },
      ]

    case EventType.TEXT_MESSAGE_START:
      return [{ type: 'text-start', id: event.messageId }]
    case EventType.TEXT_MESSAGE_CONTENT:
      return [{ type: 'text-delta', id: event.messageId, delta: event.delta }]
    case EventType.TEXT_MESSAGE_END:
      return [{ type: 'text-end', id: event.messageId }]

    case EventType.REASONING_MESSAGE_START:
      return [{ type: 'reasoning-start', id: event.messageId }]
    case EventType.REASONING_MESSAGE_CONTENT:
      return [{ type: 'reasoning-delta', id: event.messageId, delta: event.delta }]
    case EventType.REASONING_MESSAGE_END:
      return [{ type: 'reasoning-end', id: event.messageId }]

    case EventType.TOOL_CALL_START:
      state.toolNames.set(event.toolCallId, event.toolCallName)
      state.toolArgs.set(event.toolCallId, '')
      return [
        {
          type: 'tool-input-start',
          toolCallId: event.toolCallId,
          toolName: event.toolCallName,
        },
      ]
    case EventType.TOOL_CALL_ARGS:
      state.toolArgs.set(
        event.toolCallId,
        (state.toolArgs.get(event.toolCallId) ?? '') + event.delta,
      )
      return [
        { type: 'tool-input-delta', toolCallId: event.toolCallId, inputTextDelta: event.delta },
      ]
    case EventType.TOOL_CALL_END: {
      const meta = asRecord(event.metadata)
      if (meta?.inputError === true) {
        return [
          {
            type: 'tool-input-error',
            toolCallId: event.toolCallId,
            toolName: state.toolNames.get(event.toolCallId) ?? 'unknown',
            input: safeJson(state.toolArgs.get(event.toolCallId) ?? '{}'),
            errorText: String(meta.errorText ?? '工具入参不合法'),
          },
        ]
      }
      return [
        {
          type: 'tool-input-available',
          toolCallId: event.toolCallId,
          toolName: state.toolNames.get(event.toolCallId) ?? 'unknown',
          input: safeJson(state.toolArgs.get(event.toolCallId) ?? '{}'),
        },
      ]
    }
    case EventType.TOOL_CALL_RESULT: {
      const content = typeof event.content === 'string' ? safeJson(event.content) : event.content
      const meta = asRecord(event.metadata)
      if (meta?.isError === true) {
        return [
          {
            type: 'tool-output-error',
            toolCallId: event.toolCallId,
            errorText:
              typeof content === 'string' ? content : JSON.stringify(content ?? '工具执行失败'),
          },
        ]
      }
      return [{ type: 'tool-output-available', toolCallId: event.toolCallId, output: content }]
    }

    case EventType.CUSTOM:
      return customToChunks(event.name, event.value)

    case EventType.RAW: {
      // 编码时认不出的块原样放在 `event.event`：解码回同一形状，补发才不会丢细节
      const raw = asRecord(event.event)
      return raw?.type ? [raw as AgUiChunk] : []
    }

    case EventType.STEP_STARTED:
    case EventType.STEP_FINISHED:
      return []

    case EventType.RUN_FINISHED:
      return [{ type: 'finish' }]
    case EventType.RUN_ERROR:
      return [{ type: 'error', errorText: event.message }]

    default:
      return []
  }
}

/** CUSTOM → chunk（与 `encodeAgUiChunk` 的业务分支一一对应） */
const customToChunks = (name: string, value: unknown): AgUiChunk[] => {
  const envelope = asRecord(value)
  const id = typeof envelope?.id === 'string' && envelope.id ? envelope.id : undefined
  const data = envelope && 'data' in envelope ? envelope.data : value

  switch (name) {
    case AGUI_CUSTOM.message:
      return [{ type: 'start', messageId: String(envelope?.messageId ?? '') }]
    case AGUI_CUSTOM.plan:
      return [{ type: 'data-plan', data }]
    case AGUI_CUSTOM.subAgent: {
      const kind = typeof envelope?.kind === 'string' ? envelope.kind : 'data-sub-agent'
      return [{ type: kind, ...(id ? { id } : {}), data }]
    }
    case AGUI_CUSTOM.toolEvent:
      return [{ type: 'data-tool-event', ...(id ? { id } : {}), data }]
    case AGUI_CUSTOM.suspended:
      return [{ type: 'data-tool-call-suspended', ...(id ? { id } : {}), data }]
    case AGUI_CUSTOM.runSuspended:
      return [{ type: 'data-run-suspended', data }]
    case AGUI_CUSTOM.queue:
      return [{ type: 'data-queue', data }]
    case AGUI_CUSTOM.usage: {
      const kind = typeof envelope?.kind === 'string' ? envelope.kind : 'data-run-usage'
      return [{ type: kind, data }]
    }
    case AGUI_CUSTOM.title:
      return [{ type: 'data-conversation-title', data }]
    case AGUI_CUSTOM.status:
      return [{ type: 'data-status', data }]
    case AGUI_CUSTOM.summary:
      return [{ type: 'data-summary', ...(id ? { id } : {}), data }]
    default:
      return []
  }
}
