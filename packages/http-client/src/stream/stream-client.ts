import { CredentialResolver } from '../core/credential-resolver.js'
import { streamConnectOnce } from './stream-transport.js'
import type { StreamConnection } from './stream-transport.js'
import { StreamClientState } from './types.js'
import type {
  StreamClientOptions,
  StreamEventHandler,
  StreamMessage,
} from './types.js'
import { StreamClientError } from './errors.js'

/** 状态事件（通过 on() 分发，与业务事件共用同一管道）。 */
const STATE_EVENTS = [
  StreamClientState.Open,
  StreamClientState.Reconnecting,
  StreamClientState.Closed,
] as const

/**
 * SSE 客户端（浏览器 / Node.js 双环境）。
 *
 * 职责：
 * - 连接状态机：idle → connecting → open ⇄ reconnecting → closed
 * - 重连循环（指数退避，可被服务端 retry: 帧覆盖；重连前重新解析凭证）
 * - Last-Event-ID 记录与重连携带
 * - 事件分发（按事件名）
 * - 认证编排（复用本包的 CredentialResolver / AuthStrategy / CredentialsManager）
 *
 * 零第三方依赖：传输层基于原生 fetch + ReadableStream。
 */
export class HttpStreamClient {
  private state: StreamClientState = StreamClientState.Idle
  private listeners = new Map<string, Set<StreamEventHandler>>()
  private controller: AbortController | null = null
  private conn: StreamConnection | null = null
  private resolver: CredentialResolver
  private retryCount = 0
  private serverRetry: number | undefined
  private lastEventId = ''
  private stopped = false
  private hiddenPaused = false
  private visibilityHandler: (() => void) | null = null

  constructor(private readonly options: StreamClientOptions) {
    this.resolver = new CredentialResolver(
      options.credentialsManager,
      options.authStrategy,
      options.credentialProvider,
    )
  }

  get currentState(): StreamClientState {
    return this.state
  }

  /**
   * 订阅事件（按事件名分发；channel 隐含在订阅 body 中）。
   * 内置状态事件：'open' / 'reconnecting' / 'closed'。
   * @returns 取消订阅函数
   */
  on(event: string, handler: StreamEventHandler): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  /** 发起连接。仅 idle / closed 状态可调用。 */
  connect(): void {
    if (
      this.state !== StreamClientState.Idle &&
      this.state !== StreamClientState.Closed
    ) {
      throw new StreamClientError(`当前状态 ${this.state} 不能发起连接`)
    }
    this.stopped = false
    this.hiddenPaused = false
    this.retryCount = 0
    this.controller = new AbortController()
    this.setState(StreamClientState.Connecting)
    this.bindVisibility()
    void this.run()
  }

  /** 关闭连接（幂等）：中断传输、进入终态、清理订阅。 */
  close(): void {
    if (
      this.state === StreamClientState.Idle ||
      this.state === StreamClientState.Closed
    ) {
      return
    }
    this.stopped = true
    this.unbindVisibility()
    this.controller?.abort()
    this.conn = null
    this.setState(StreamClientState.Closed)
    this.listeners.clear()
  }

  /** 重连循环：连接 → 断开/出错 → 退避重连，直到 close() 或服务端正常关流。 */
  private async run(): Promise<void> {
    while (!this.stopped) {
      if (this.hiddenPaused) {
        await this.waitUntilVisible()
        this.hiddenPaused = false
        continue
      }
      try {
        this.setState(StreamClientState.Connecting)

        // 认证编排：解析有效凭证 → 生成认证 headers（复用本包凭证体系）
        const credentials = await this.resolver.resolve()
        const ctx = await this.options.authStrategy.getAuthContext(credentials, {})
        const headers: Record<string, string> = {
          ...this.options.headers,
          ...(ctx.headers || {}),
        }
        if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId

        const conn = streamConnectOnce(
          {
            url: this.options.url,
            method: this.options.method ?? 'POST',
            headers,
            body: this.buildBody(),
            signal: this.controller!.signal,
            fetchImpl: this.options.fetch,
          },
          {
            onOpen: () => this.setState(StreamClientState.Open),
            onMessage: (msg) => this.handleMessage(msg),
            onRetry: (retry) => {
              this.serverRetry = retry
            },
          },
        )
        this.conn = conn
        await conn.closed

        if (this.stopped) break
        // abort 因页面隐藏：回到循环顶部等待可见
        if (this.hiddenPaused) continue
        // 服务端正常关闭流 → 进入终态（不自动重连）
        this.setState(StreamClientState.Closed)
        break
      } catch (err) {
        if (this.stopped) break
        this.retryCount += 1
        this.setState(StreamClientState.Reconnecting)
        const ms = this.nextRetryMs()
        await delay(ms, this.controller?.signal)
      }
    }
  }

  private buildBody(): string | undefined {
    const { body, channels, method } = this.options
    if (body !== undefined) return JSON.stringify(body)
    if ((method ?? 'POST').toUpperCase() === 'POST') {
      return JSON.stringify({ channels: channels ?? [] })
    }
    return undefined
  }

  private handleMessage(msg: StreamMessage): void {
    if (msg.id) this.lastEventId = msg.id
    const handlers = this.listeners.get(msg.event)
    if (!handlers || handlers.size === 0) return

    let data: unknown = msg.data
    if (msg.data !== '') {
      try {
        data = JSON.parse(msg.data)
      } catch {
        // 非 JSON 负载：原样分发原始字符串，由业务侧决定
      }
    }
    for (const handler of handlers) {
      try {
        handler(data, msg)
      } catch (handlerErr) {
        console.warn('[http-stream-client] 事件处理器执行异常', handlerErr)
      }
    }
  }

  private nextRetryMs(): number {
    if (this.serverRetry !== undefined) return this.serverRetry
    const base = this.options.retryInterval ?? 1000
    const max = this.options.maxRetryInterval ?? 30000
    return Math.min(base * 2 ** (this.retryCount - 1), max)
  }

  private setState(state: StreamClientState): void {
    this.state = state
    if ((STATE_EVENTS as readonly string[]).includes(state)) {
      this.dispatchStateEvent(state as (typeof STATE_EVENTS)[number])
    }
  }

  /** 状态事件：handler(data=undefined, message={event: 状态名}) */
  private dispatchStateEvent(event: string): void {
    const handlers = this.listeners.get(event)
    if (!handlers || handlers.size === 0) return
    const message: StreamMessage = { id: '', event, data: '' }
    for (const handler of handlers) {
      try {
        handler(undefined, message)
      } catch (handlerErr) {
        console.warn('[http-stream-client] 状态事件处理器执行异常', handlerErr)
      }
    }
  }

  /** 浏览器页面隐藏时的暂停/恢复（Node 环境跳过）。 */
  private bindVisibility(): void {
    if (this.options.openWhenHidden) return
    if (typeof document === 'undefined') return
    this.visibilityHandler = () => {
      if (document.hidden && !this.stopped) {
        this.hiddenPaused = true
        this.controller?.abort()
      }
    }
    document.addEventListener('visibilitychange', this.visibilityHandler)
  }

  private unbindVisibility(): void {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
  }

  private waitUntilVisible(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!document.hidden) {
          document.removeEventListener('visibilitychange', check)
          resolve()
        }
      }
      document.addEventListener('visibilitychange', check)
      check()
    })
  }
}

/** 可中断延时（abort 时提前返回）。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
