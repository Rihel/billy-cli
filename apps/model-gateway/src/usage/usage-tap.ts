import type { GatewayUsage } from '@repo/contracts'
import { mergeUsage, usageOf } from './usage.js'

export interface StreamTap {
  /** 把上游字节原样透出（不改变帧） */
  stream: ReadableStream<Uint8Array>
  /** 首块到达时间（用于 TTFT） */
  firstChunkAt: () => number | null
  /** 结束时取用量（最后一个带 usage 的事件） */
  usage: () => GatewayUsage | null
}

const decoder = new TextDecoder()

/** SSE：逐帧 `data: {...}`，取最后一个带 usage 的事件 */
export const tapSseStream = (upstream: ReadableStream<Uint8Array>): StreamTap => {
  let buffer = ''
  let latest: GatewayUsage | null = null
  let firstAt: number | null = null
  const reader = upstream.getReader()
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        if (firstAt === null) firstAt = Date.now()
        controller.enqueue(value)
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line.startsWith('data:')) {
            const raw = line.slice(5).trim()
            if (raw && raw !== '[DONE]') {
              try {
                const usage = usageOf(JSON.parse(raw))
                if (usage) latest = latest ? mergeUsage(latest, usage) : usage
              } catch {
                // 非 JSON 帧忽略
              }
            }
          }
          index = buffer.indexOf('\n')
        }
        return
      }
    },
    cancel() {
      return reader.cancel()
    },
  })
  return { stream, firstChunkAt: () => firstAt, usage: () => latest }
}

/** NDJSON（Ollama）：逐行 JSON，取最后一行 usage */
export const tapNdjsonStream = (upstream: ReadableStream<Uint8Array>): StreamTap => {
  let buffer = ''
  let latest: GatewayUsage | null = null
  let firstAt: number | null = null
  const reader = upstream.getReader()
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }
      if (firstAt === null) firstAt = Date.now()
      controller.enqueue(value)
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) {
          try {
            const row = JSON.parse(line) as Record<string, unknown>
            const prompt = typeof row.prompt_eval_count === 'number' ? row.prompt_eval_count : null
            const output = typeof row.eval_count === 'number' ? row.eval_count : null
            if (prompt !== null || output !== null) {
              latest = {
                inputTokens: prompt,
                outputTokens: output,
                totalTokens: prompt !== null && output !== null ? prompt + output : null,
                cacheReadTokens: null,
                cacheWriteTokens: null,
                reasoningTokens: null,
              }
            }
          } catch {
            // 忽略坏行
          }
        }
        index = buffer.indexOf('\n')
      }
    },
    cancel() {
      return reader.cancel()
    },
  })
  return { stream, firstChunkAt: () => firstAt, usage: () => latest }
}

/** 按协议选 tap：ollama 走 NDJSON，其余走 SSE */
export const tapUpstreamStream = (
  protocol: string,
  upstream: ReadableStream<Uint8Array>,
): StreamTap => (protocol === 'ollama' ? tapNdjsonStream(upstream) : tapSseStream(upstream))
