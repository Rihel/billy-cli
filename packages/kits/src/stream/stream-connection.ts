import type { StreamEventModel } from '@repo/shared'

/** SSE 帧（传输层载荷，字段与 WHATWG SSE 帧一致；由 writer 实现负责编码）。 */
export interface StreamFrame {
  /** 事件名（帧的 `event:` 字段） */
  event?: string
  /** 事件数据（帧的 `data:` 字段，必须是字符串） */
  data: string
  /** 事件 id（帧的 `id:` 字段，续传用） */
  id?: string
}

/** StreamConnection 构造选项。 */
export interface StreamConnectionOptions {
  /** 写 SSE 帧（封装传输层写通道，如 Express res.write） */
  writer: (frame: StreamFrame) => Promise<void>
  /** 写原始块（心跳注释行用；缺省时心跳仅维持计时器不落盘） */
  rawWriter?: (chunk: string) => Promise<void>
  /** 请求中止信号（客户端断开 → 自动 close，幂等） */
  signal?: AbortSignal
  /** 心跳间隔毫秒（周期写注释行保活，防止代理超时断流），默认 15000；传 0 关闭 */
  heartbeatIntervalMs?: number
}

/**
 * 单条 SSE 长连接（服务端侧）。
 *
 * 生命周期：由 StreamHub.createConnection 创建 → 订阅频道 → 推流 →
 * 客户端断开（abort 信号）或服务端 close() → 触发 onClose 注销（幂等）。
 * HTTP 生命周期驱动，无复杂流转（对应设计文档 §4.2）。
 */
export class StreamConnection {
  /** 连接唯一 id（StreamHub 生成，可作事件 id 前缀） */
  readonly id: string
  /** 已订阅频道集合（StreamHub 频道索引维护，这里仅记录） */
  readonly channels = new Set<string>()
  /** 连接关闭承诺：abort / close() 后 resolve，供路由挂起长连接 */
  readonly closed: Promise<void>

  private readonly options: StreamConnectionOptions
  private readonly onClose: (connection: StreamConnection) => void
  private resolveClosed!: () => void
  private isClosed = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    id: string,
    options: StreamConnectionOptions,
    onClose: (connection: StreamConnection) => void,
  ) {
    this.id = id
    this.options = options
    this.onClose = onClose
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve
    })

    const { signal, heartbeatIntervalMs = 15000 } = options
    if (signal) {
      if (signal.aborted) {
        // 连接建立前请求已断开：异步置为关闭态
        queueMicrotask(() => this.close())
      } else {
        signal.addEventListener('abort', () => this.close(), { once: true })
      }
    }
    if (heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        void this.heartbeat()
      }, heartbeatIntervalMs)
    }
  }

  /** 推一条业务事件（写失败视为连接已断开，自动 close）。 */
  async write(event: StreamEventModel): Promise<void> {
    if (this.isClosed) return
    try {
      await this.options.writer({
        id: event.id,
        event: event.event,
        data: JSON.stringify(event.data ?? null),
      })
    } catch {
      this.close()
    }
  }

  /** 服务端主动关流（幂等）。 */
  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.onClose(this)
    this.resolveClosed()
  }

  private async heartbeat(): Promise<void> {
    if (this.isClosed || !this.options.rawWriter) return
    try {
      await this.options.rawWriter(': ping\n\n')
    } catch {
      this.close()
    }
  }
}
