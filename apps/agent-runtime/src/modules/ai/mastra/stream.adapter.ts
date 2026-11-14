import { toAISdkStream } from '@mastra/ai-sdk'
import { toErrorText } from './error.adapter.js'

/** UI Message Stream 里我们关心的字段；其余原样透传 */
export interface UiChunk {
  type?: string
  id?: string
  delta?: string
  [key: string]: unknown
}

/**
 * 这些片段一出现，思考就该收口。
 * 不收口的话，前端会一直显示「思考中」，即使答案已经开始往外吐了。
 */
const CLOSES_REASONING = new Set([
  'text-start',
  'text-delta',
  'tool-input-start',
  'tool-input-available',
  'tool-output-available',
  'tool-output-error',
  'start-step',
  'finish-step',
  'finish',
  'error',
])

/**
 * 给思考块补 `reasoning-start` / `reasoning-end`（**幂等修正**）。
 *
 * 为什么需要：AI SDK 的前端在收到 `reasoning-delta` 时，如果找不到对应的
 * `reasoning-start`，会直接抛错并整页 500：
 * `Received reasoning-delta for missing reasoning part with ID "reasoning-0"`。
 * 而有些提供方（最典型是 DeepSeek 的 `reasoning_content`）只发增量、不发开始标记。
 *
 * 做法：reasoning 的 id 由我们统一发号（`reasoning-0`、`reasoning-1`…），
 * 上游的 start / delta / end 都改写成同一个新 id；上游只发 delta 时补一个 start。
 * 同一段思考结束后再次出现，就换新 id，避免前端「重复 start」或「找不到 part」。
 */
export function reasoningSafeTransform(): TransformStream<UiChunk, UiChunk> {
  let seq = 0
  let active: { upstream: string; id: string } | null = null

  /** 上游有时 start 不带 id、delta 才带；空 id 视为同一段，不要拆成两块 */
  const sameBlock = (block: { upstream: string }, upstream: string) =>
    !block.upstream || !upstream || block.upstream === upstream

  const close = (controller: TransformStreamDefaultController<UiChunk>) => {
    if (!active) return
    controller.enqueue({ type: 'reasoning-end', id: active.id })
    active = null
  }

  return new TransformStream<UiChunk, UiChunk>({
    transform(chunk, controller) {
      const type = String(chunk?.type ?? '')
      const upstream = typeof chunk?.id === 'string' ? chunk.id : ''

      if (type === 'reasoning-start') {
        // 同一段重复 start：丢掉，前端看到两个 start 一样会炸
        if (active && sameBlock(active, upstream)) {
          if (!active.upstream && upstream) active.upstream = upstream
          return
        }
        close(controller)
        active = { upstream, id: `reasoning-${seq++}` }
        controller.enqueue({ ...chunk, id: active.id })
        return
      }

      if (type === 'reasoning-delta') {
        if (active && sameBlock(active, upstream)) {
          if (!active.upstream && upstream) active.upstream = upstream
        } else {
          close(controller)
          active = { upstream, id: `reasoning-${seq++}` }
          // 只有增量、没有开始标记的提供方，在这里补上
          controller.enqueue({ type: 'reasoning-start', id: active.id })
        }
        controller.enqueue({ ...chunk, id: active.id })
        return
      }

      if (type === 'reasoning-end') {
        // 没有对应的 start 就没有 part 可结束，直接吞掉
        if (active && sameBlock(active, upstream)) close(controller)
        return
      }

      if (CLOSES_REASONING.has(type)) close(controller)
      controller.enqueue(chunk)
    },

    flush(controller) {
      // 流结束时还没收口的思考，补一个 end
      close(controller)
    },
  })
}

/**
 * **Mastra 流 → AI SDK v6 UI Message Stream**（适配器，设计 §5.8）。
 *
 * 收在一处的原因：AI SDK 的 part 名（`text-delta` / `tool-input-available` / `tool-output-error`…）
 * 是**上游词汇**，我们只在录制器里认它们（`stream-recorder.ts` 的 switch）。
 * 上游换版本时，改动落在这里与录制器的映射上，不散到编排层。
 *
 * 在转换之后再过一道 `reasoningSafeTransform`：把「只有 delta、没有 start」的
 * 思考流补成合法序列，否则前端整页 500（见上方注释）。
 *
 * `onError` 显式给成 `toErrorText`：上游默认把错误对象 `JSON.stringify` 进 `errorText`，
 * durable 下错误会以 `{ name, message, stack }` 普通对象回来，于是错误卡片里直接出现
 * 整段 JSON 与 `@mastra/core` 内部堆栈（见 {@link toErrorText}）。
 */
export const toUiStream = (output: unknown): ReadableStream<unknown> =>
  (
    toAISdkStream(output as never, {
      from: 'agent',
      version: 'v6',
      sendReasoning: true,
      sendSources: true,
      onError: toErrorText,
    }) as unknown as ReadableStream<UiChunk>
  ).pipeThrough(reasoningSafeTransform()) as unknown as ReadableStream<unknown>
