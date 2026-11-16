import { EventType } from '@ag-ui/core'
import { AGUI_EVENT_TYPES, AGUI_FINAL_CHUNK_TYPES } from './agui.constant.js'
import type { AgUiEvent } from './agui.types.js'

/** 一个 SSE 帧里可能有多行 `data:`：按规范用换行拼起来 */
const payloadOf = (frame: string): string =>
  frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')

/**
 * 解析 AG-UI 的 SSE 流（**按 `\n\n` 跨 chunk 缓冲**，否则半截 JSON 会解析失败）。
 *
 * 三条容错口径：
 * - 注释帧（`: ping`）与非 JSON 帧直接跳过；
 * - `[DONE]` 兼容但**不应出现**：AG-UI 的收尾是 `RUN_FINISHED`，官方客户端遇到 `[DONE]`
 *   会 `JSON.parse` 抛错并把整条流 error 掉（手册 §8 坑 1）；
 * - 流结束前没有 `\n\n` 的尾帧也要冲出来（服务端直接 `end()` 时会出现）。
 */
export interface ParseAgUiSseOptions {
  /** 取消信号：组件卸载 / 关闭弹窗时中止读取，并把底层 reader cancel 掉 */
  signal?: AbortSignal
}

export async function* parseAgUiSse(
  input: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: ParseAgUiSseOptions = {},
): AsyncGenerator<AgUiEvent> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const piece of iterate(input, options.signal)) {
    buffer += decoder.decode(piece, { stream: true })
    buffer = buffer.replaceAll('\r\n', '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const event = parseFrame(frame)
      if (event) yield event
      boundary = buffer.indexOf('\n\n')
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) {
    const event = parseFrame(buffer)
    if (event) yield event
  }
}

function parseFrame(frame: string): AgUiEvent | null {
  const payload = payloadOf(frame)
  if (!payload || payload === '[DONE]') return null
  try {
    const parsed = JSON.parse(payload) as { type?: unknown }
    if (!parsed || typeof parsed !== 'object') return null
    if (!AGUI_EVENT_TYPES.has(String(parsed.type))) return null
    return parsed as AgUiEvent
  } catch {
    return null
  }
}

async function* iterate(
  input: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (signal?.aborted) return
  /**
   * 优先走 `getReader()`：它在取消时要 `reader.cancel()` 才能把底层 fetch body 放掉。
   * 只写 `yield* input` 的话，消费者取消后源流会一直挂着（组件卸载后连接泄漏）。
   */
  if (typeof (input as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (input as ReadableStream<Uint8Array>).getReader()
    const abort = (): void => {
      void reader.cancel().catch(() => undefined)
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (value) yield value
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      try {
        reader.releaseLock()
      } catch {
        // reader 已因 cancel / 流结束释放
      }
    }
  }
  yield* input as AsyncIterable<Uint8Array>
}

/** 这个对象是不是 AG-UI 事件（旧记录是 chunk，两种形态会在 TTL 内共存） */
export const isAgUiEvent = (value: unknown): value is AgUiEvent =>
  typeof value === 'object' &&
  value !== null &&
  AGUI_EVENT_TYPES.has(String((value as { type?: unknown }).type))

/**
 * 这一帧是否代表「这一轮结束」。
 *
 * 三种形态都认：AG-UI 的 `RUN_FINISHED`、解码后的 `finish`、旧记录里的 `__run_end__`。
 * 只认一种就会出现"结束帧到了、连接还挂着"（手册 §8 坑 4）。
 */
export const isRunFinalEvent = (value: unknown): boolean => {
  const type = (value as { type?: unknown } | null)?.type
  return type === EventType.RUN_FINISHED || AGUI_FINAL_CHUNK_TYPES.has(String(type))
}
