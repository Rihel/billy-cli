import type { AgUiEvent } from '@repo/shared'
import { STREAM_END_MARKER, type StreamResponseLike } from '../runtime/stream/stream-response.js'
import type { RunStopReason } from './protocol.js'

/**
 * 引擎事件的无界异步队列。
 *
 * 为什么无界：Chat 执行体是「写 SSE」语义 —— 它不能因为消费者慢而被反压，
 * 否则模型流会被拖住、心跳会断。背压由 Redis 补发记录承担（消费者慢时可以按 rev 重连）。
 */
export class AsyncEventQueue<T> {
  private readonly buffered: T[] = []
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  private closed = false
  private failure: unknown = null

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ value, done: false })
      return
    }
    this.buffered.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as never, done: true })
    }
  }

  fail(error: unknown): void {
    if (this.closed) return
    this.failure = error
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error)
    }
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.buffered.length > 0) {
      return Promise.resolve({ value: this.buffered.shift() as T, done: false })
    }
    if (this.closed) {
      if (this.failure !== null) return Promise.reject(this.failure)
      return Promise.resolve({ value: undefined as never, done: true })
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined as never, done: true })
      },
    }
  }
}

/**
 * 流控制帧：`__run_end__` 不是 AG-UI 事件，但它是 wire format 的一部分
 * （补发连接与客户端都靠它收尾），所以引擎事件流要原样带上。
 */
export type EngineStreamEvent = AgUiEvent | { type: typeof STREAM_END_MARKER }

/** Chat 执行体输出的原始帧 → 引擎事件 */
const parseFrames = (chunk: string): unknown[] => {
  const events: unknown[] = []
  for (const frame of chunk.split('\n\n')) {
    const line = frame.trim()
    if (!line || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    try {
      events.push(JSON.parse(payload))
    } catch {
      // 半帧 / 非 JSON：SSE 层不负责解释，丢弃这一帧（真有业务帧解析失败会在上层记日志）
    }
  }
  return events
}

/**
 * 把 Chat 执行体写的 SSE 帧收成 `AsyncIterable<AgUiEvent>`。
 *
 * 实现 `StreamResponseLike` 是为了让现有执行体**不改写**：它仍然以为自己
 * 在写 Express 响应，而引擎拿到的是可迭代事件流。收尾标记 `__run_end__`
 * 不是 AG-UI 事件，在这里被消费掉（消费者通过 `result` 判断结束）。
 */
export class RunEventSink implements StreamResponseLike {
  private readonly queue = new AsyncEventQueue<EngineStreamEvent>()
  private ended = false

  readonly events: AsyncIterable<EngineStreamEvent> = {
    [Symbol.asyncIterator]: () => this.queue[Symbol.asyncIterator](),
  }

  get writableEnded(): boolean {
    return this.ended
  }

  writeHead(): unknown {
    return this
  }

  flushHeaders(): void {}

  write(chunk: string): boolean {
    for (const event of parseFrames(chunk) as Array<{ type?: string }>) {
      // 结束标记是流控制帧：原样交给消费者转发，**不关闭队列** ——
      // 执行体在它之后还会冲残余增量（合并器），提前关会丢最后 100ms 的内容。
      this.queue.push(event as EngineStreamEvent)
    }
    return true
  }

  end(): unknown {
    this.close()
    return this
  }

  on(): unknown {
    return this
  }

  status(): { end: () => unknown } {
    return { end: () => this.end() }
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    this.queue.close()
  }

  fail(error: unknown): void {
    if (this.ended) return
    this.ended = true
    this.queue.fail(error)
  }
}

/** 引擎侧的一次运行结果（Host 通过 `RunExecution.result` 拿它） */
export interface RunOutcome {
  runId: string
  conversationId: string
  status: 'succeeded' | 'failed' | 'canceled' | 'suspended'
  stopReason: RunStopReason
  usage: Record<string, unknown> | null
  error?: { code: string; message: string }
}

/** Host 看到的执行句柄：事件流 + 结果 */
export interface RunExecution {
  runId: string
  conversationId: string
  taskId: string | null
  events: AsyncIterable<EngineStreamEvent>
  result: Promise<RunOutcome>
  /** 中止本次执行（Host 断开 / 网关超时；语义等同停止） */
  abort(reason?: string): void
}
