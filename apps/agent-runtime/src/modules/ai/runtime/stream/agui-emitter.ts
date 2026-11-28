import { encodeAgUiChunk, type AgUiChunk } from '@repo/shared'
import type { AppLogger } from '@repo/kits'
import type { StreamPublisher } from '../../engine/ports.js'
import { DeltaCoalescer, isCoalescedDelta } from './stream-deltas.js'
import type { StreamResponseLike } from './stream-response.js'
import { endSse, sseFrame, writeSse } from './stream-response.js'

/** 增量合并的触发间隔（ms） */
export const STREAM_DELTA_FLUSH_MS = 100
/** 增量合并的字符上限（到量立即 flush，不等定时器） */
export const STREAM_DELTA_MAX_CHARS = 2_000

/** 一次发射的上下文 */
interface EmitInput {
  runId: string
  threadId: string
  chunk: unknown
  response?: StreamResponseLike
  messageIdRef?: { value: string }
}

/**
 * **唯一发射口**：chunk → AG-UI 事件 → 输出记录（rev）→ 定向广播 →（可选）响应体。
 *
 * 四条路径（建流 / 续跑 / 无头执行 / 收尾）都必须走这里。漏一条就会留下 chunk 帧，
 * 于是"存的是事件、传的 chunk"，两套映射迟早漂移（手册 §4.1）。
 *
 * 两类块走两条路：
 * - **增量块**（`text-delta` / `reasoning-delta` / `data-sub-agent-delta`）只进合并器，
 *   攒 100ms 或 2k 字再一起发射（见 `stream-deltas.ts`）—— 逐 token 发射的固定成本
 *   远大于内容本身；
 * - **其它块**（part 边界 / 工具 / 计划 / 收尾 / 用量）先冲掉攒着的增量，再立即发射，
 *   保证顺序与"结束帧一定在正文之后"。
 */
export class AgUiEmitter {
  private readonly deltaCoalescers = new Map<
    string,
    {
      ctx: { runId: string; threadId: string; response?: StreamResponseLike }
      coalescer: DeltaCoalescer
    }
  >()

  constructor(
    private readonly streams: StreamPublisher,
    private readonly logger: AppLogger,
  ) {}

  async emit(input: EmitInput): Promise<number> {
    const coalescer = this.coalescerOf(input)
    if (isCoalescedDelta(input.chunk)) {
      coalescer.push(input.chunk)
      return coalescer.rev
    }
    // 非增量块：先把缓冲冲出去（顺序），再排在它后面发射
    await coalescer.flush()
    return coalescer.run(() => this.emitChunk(input))
  }

  /** 收尾：冲掉残余增量并停表（随后到达的 push 会被丢弃 —— 那时这一轮已经结束） */
  async dispose(runId: string): Promise<void> {
    const entry = this.deltaCoalescers.get(runId)
    if (!entry) return
    this.deltaCoalescers.delete(runId)
    await entry.coalescer.dispose()
  }

  /** 只把 chunk 编成 AG-UI 写进响应体（HTTP 体不承载消费，main 只 drain） */
  writeToResponse(
    response: StreamResponseLike,
    chunk: unknown,
    ctx: { threadId: string; runId: string; messageId?: string },
  ): void {
    for (const event of encodeAgUiChunk(chunk as AgUiChunk, ctx)) {
      writeSse(response, sseFrame(event))
    }
  }

  /** 收尾：写一帧 `RUN_FINISHED`（进记录 + 广播 + 响应体），再关响应 */
  async finish(response: StreamResponseLike, runId: string, threadId: string): Promise<void> {
    await this.emit({ runId, threadId, chunk: { type: '__run_end__' }, response })
    endSse(response)
  }

  /** 取（或建）这一轮的合并器：`response` / `threadId` 以最新一次传入的为准 */
  private coalescerOf(input: {
    runId: string
    threadId: string
    response?: StreamResponseLike
  }): DeltaCoalescer {
    let entry = this.deltaCoalescers.get(input.runId)
    if (!entry) {
      const ctx: { runId: string; threadId: string; response?: StreamResponseLike } = {
        runId: input.runId,
        threadId: input.threadId,
      }
      const coalescer = new DeltaCoalescer({
        intervalMs: STREAM_DELTA_FLUSH_MS,
        maxChars: STREAM_DELTA_MAX_CHARS,
        sink: (chunks) => this.emitChunks(ctx, chunks),
        onError: (error) => {
          this.logger.warn('ai.stream.emit_failed', {
            runId: input.runId,
            reason: error instanceof Error ? error.message : String(error),
          })
        },
      })
      entry = { ctx, coalescer }
      this.deltaCoalescers.set(input.runId, entry)
    }
    // 响应体是"顺带写一份"的可选通道（main 只 drain）：哪次调用带了就记上，不带时沿用上一次
    if (input.response) entry.ctx.response = input.response
    if (input.threadId) entry.ctx.threadId = input.threadId
    return entry.coalescer
  }

  /** 发一块（非增量）：等闸门 → 编码 → 追加 + 广播 + 响应体 */
  private async emitChunk(input: EmitInput): Promise<number> {
    // 补发闸门：补发期间产事件的一侧**不放行**，避免实时事件插到重放中间
    await this.streams.waitForReplayGate(input.runId)
    const chunk = input.chunk as { type?: string; messageId?: string } | null
    if (input.messageIdRef && chunk?.type === 'start' && typeof chunk.messageId === 'string') {
      input.messageIdRef.value = chunk.messageId
    }
    const events = encodeAgUiChunk(chunk as AgUiChunk, {
      threadId: input.threadId,
      runId: input.runId,
      ...(input.messageIdRef?.value ? { messageId: input.messageIdRef.value } : {}),
    })
    return this.appendAndBroadcast(input, events)
  }

  /** 发一批（合并后的增量）：闸门只等一次，追加与广播也各一次 */
  private async emitChunks(
    input: { runId: string; threadId: string; response?: StreamResponseLike },
    chunks: Array<Record<string, unknown>>,
  ): Promise<number> {
    if (chunks.length === 0) return 0
    await this.streams.waitForReplayGate(input.runId)
    const ctx = { threadId: input.threadId, runId: input.runId }
    const events: unknown[] = []
    for (const chunk of chunks) events.push(...encodeAgUiChunk(chunk as AgUiChunk, ctx))
    return this.appendAndBroadcast(input, events)
  }

  /** 事件 → 输出记录（rev）→ 定向广播 → 响应体（批量各一次） */
  private async appendAndBroadcast(
    input: { runId: string; response?: StreamResponseLike },
    events: readonly unknown[],
  ): Promise<number> {
    if (events.length === 0) return 0
    const rev = await this.streams.appendEvents(input.runId, events)
    await this.streams.publishEvents(input.runId, events)
    if (input.response) {
      for (const event of events) writeSse(input.response, sseFrame(event))
    }
    return rev
  }
}
