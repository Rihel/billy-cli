import { DefaultChatTransport } from 'ai'
import type { UIMessage, UIMessageChunk } from 'ai'
import {
  agUiEventToChunks,
  createAgUiDecodeState,
  parseAgUiSse,
  type AgUiChunk,
} from '@repo/shared'

/**
 * 逐帧增量块：按 AI SDK 的 **transient** 语义处理 —— 只走 `onData`，**不落成 part**。
 *
 * 为什么在这里做（2026-11-03，会话 vske8ur0le74hwsfii0s 卡死）：子助手的正文/推理增量是
 * "一块一个"发出来的（`data-sub-agent-delta`，不带 id），SDK 对不带 id 的 data 块**每块 push
 * 一个 part**（`ai/dist/index.js` 的 `processUIMessageStream`）。4 路并行子助手一轮下来，
 * 一条消息的 parts 会被撑到数万条；而 SDK 每次提交都要 `parts.map(part => ({...part}))` 全量快照，
 * 渲染层也要按 parts 长度生成 children —— 页面因此卡死。
 *
 * 这个字段是协议**本来就为此设计**的（`ai-agent.md` §5.2 / §5.4：进度类增量走 transient，
 * 内容与状态走持久 part），只是当初写流的时候没落到实现上。这里在**传输层**改回来：
 * 数据照常一块块到达 `onData`，只是不再变成 part —— 后端一个字都不用改。
 */
export const TRANSIENT_DATA_CHUNK_TYPES: ReadonlySet<string> = new Set([
  'data-sub-agent-delta',
  /**
   * 排队应答：只用于横幅提示，**不是消息内容**。
   * 不标 transient 的话，会话忙时发一条消息会额外多出一条"（空消息）"气泡。
   */
  'data-queue',
])

/** 给指定的 data 块打上 `transient` 标记（纯函数，可单测） */
export const markTransientChunks = (
  stream: ReadableStream<UIMessageChunk>,
  types: ReadonlySet<string> = TRANSIENT_DATA_CHUNK_TYPES,
): ReadableStream<UIMessageChunk> =>
  stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type && types.has(chunk.type)) {
          controller.enqueue({ ...chunk, transient: true } as UIMessageChunk)
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )

/**
 * AG-UI SSE → AI SDK 的 chunk 流（**唯一一层适配**）。
 *
 * 渲染模型保持不变（`useChat` + `UIMessage.parts`），只把传输换掉：
 * `data: {...AG-UI event...}` → `agUiEventToChunks` → `UIMessageChunk`。
 * `decodeState` 要贯穿整条流 —— 工具入参靠 `TOOL_CALL_ARGS` 累积，每条事件新建一份就永远拼不出 input。
 *
 * 不再调 `super.processResponseStream`：父类解析的是 AI SDK 自己的 SSE 方言，
 * 我们的服务端现在发的是 AG-UI 事件。跳过父类不会丢能力（`onData` / 消息归并都在
 * `processUIMessageStream` 里，由 `useChat` 自己按 chunk 处理）。
 */
export const agUiSseToChunkStream = (
  stream: ReadableStream<Uint8Array>,
): ReadableStream<UIMessageChunk> =>
  new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const state = createAgUiDecodeState()
      try {
        for await (const event of parseAgUiSse(stream)) {
          for (const chunk of agUiEventToChunks(event, state)) {
            controller.enqueue(chunk as AgUiChunk as UIMessageChunk)
          }
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })

/**
 * 会话页用的传输层：AG-UI SSE → chunk，再叠一层"增量块不落 part"。
 *
 * 断线重连（`reconnectToStream`）走的是同一个 `processResponseStream`，所以恢复流
 * （快照 + `sinceRev` 增量）同样会经过这份适配 —— 恢复不需要另一套解析。
 */
export class ChatTransport extends DefaultChatTransport<UIMessage> {
  protected override processResponseStream(
    stream: ReadableStream<Uint8Array>,
  ): ReadableStream<UIMessageChunk> {
    return markTransientChunks(agUiSseToChunkStream(stream))
  }
}
