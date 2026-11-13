import { DefaultChatTransport } from 'ai'
import type { UIMessage, UIMessageChunk } from 'ai'

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
 *
 * 为什么改在 `processResponseStream` 而不是 SSE 字节流：SDK 已经把 SSE 解析成 chunk 对象了，
 * 在这里按 `type` 打标记是最稳的位置（不碰编码、不手写解析）。
 */
export const TRANSIENT_DATA_CHUNK_TYPES: ReadonlySet<string> = new Set(['data-sub-agent-delta'])

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
 * 会话页用的传输层：在默认实现上加一层"增量块不落 part"。
 *
 * 续传（`reconnectToStream`）走的是同一个 `processResponseStream`，所以断线重连补发的
 * 增量块同样不会堆成 part —— 这也是"重开页面又卡一次"的那个入口。
 */
export class ChatTransport extends DefaultChatTransport<UIMessage> {
  protected override processResponseStream(
    stream: ReadableStream<Uint8Array>,
  ): ReadableStream<UIMessageChunk> {
    return markTransientChunks(super.processResponseStream(stream))
  }
}
