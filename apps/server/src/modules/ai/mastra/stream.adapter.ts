import { toAISdkStream } from '@mastra/ai-sdk'

/**
 * **Mastra 流 → AI SDK v6 UI Message Stream**（适配器，设计 §5.8）。
 *
 * 收在一处的原因：AI SDK 的 part 名（`text-delta` / `tool-input-available` / `tool-output-error`…）
 * 是**上游词汇**，我们只在录制器里认它们（`stream-recorder.ts` 的 switch）。
 * 上游换版本时，改动落在这里与录制器的映射上，不散到编排层。
 */
export const toUiStream = (output: unknown): ReadableStream<unknown> =>
  toAISdkStream(output as never, {
    from: 'agent',
    version: 'v6',
    sendReasoning: true,
    sendSources: true,
  }) as unknown as ReadableStream<unknown>
