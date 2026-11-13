import { STREAM_SHUTDOWN_EVENT } from '@repo/shared'
import { CredentialResolver } from '../core/credential-resolver.js'
import { streamConnectOnce } from './stream-transport.js'
import type { StreamConnection } from './stream-transport.js'
import { StreamClientState } from './types.js'
import type { StreamClientOptions, StreamEventHandler, StreamMessage } from './types.js'
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
 *
 * 凭证类型对构造参数泛型化（默认 `Record<string, any>`）：SSE 与普通请求共用同一份凭证，
 * 调用方传 `LocalStorageCredentialsManager<BearerTokenCredentials>` 这类具体管理器时，
 * 不再需要断言（`CredentialsManager` 的 `setCredentials` 入参使类型不变，无法靠协变兼容）。
 */
export class HttpStreamClient<Credentials = Record<string, any>> {
  private state: StreamClientState = StreamClientState.Idle
  private listeners = new Map<string, Set<StreamEventHandler>>()
  private controller: AbortController | null = null
  private conn: StreamConnection | null = null
  private resolver: CredentialResolver<Credentials>
  private retryCount = 0
  private serverRetry: number | undefined
  private lastEventId = ''
  private stopped = false
  private hiddenPaused = false
  /** 服务端已宣告排空（收到 `stream.shutdown`）：流结束后要重连，而不是进入终态 */
  private serverShutdown = false
  private visibilityHandler: (() => void) | null = null

  constructor(private readonly options: StreamClientOptions<Credentials>) {
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
    if (this.state !== StreamClientState.Idle && this.state !== StreamClientState.Closed) {
      throw new StreamClientError(`当前状态 ${this.state} 不能发起连接`)
    }
    this.stopped = false
    this.hiddenPaused = false
    this.retryCount = 0
    this.serverShutdown = false
    // AbortController 由 run() 的每次连接尝试自己创建（见下方注释），
    // 这里不预先建，避免「一次 abort 永久失效」。
    this.controller = null
    this.setState(StreamClientState.Connecting)
    this.bindVisibility()
    void this.run()
  }

  /** 关闭连接（幂等）：中断传输、进入终态、清理订阅。 */
  close(): void {
    if (this.state === StreamClientState.Idle || this.state === StreamClientState.Closed) {
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
      // 每次尝试都用**全新**的 AbortController。
      // AbortSignal 一旦 abort 就永久处于 aborted：若整轮重连复用同一个 controller，
      // 页面隐藏触发的 abort 会让后续每次连接刚发起就被中断，而 transport 把 abort
      // 视为「正常结束」，状态机于是直接进入 closed 且不再重连 —— 表现为切回标签页后
      // 流静默失效。close() 依赖 this.controller 中断「当前」这次尝试，故这里覆盖引用。
      this.controller = new AbortController()
      const signal = this.controller.signal

      try {
        this.setState(StreamClientState.Connecting)

        // 认证编排：解析有效凭证 → 生成认证 headers（复用本包凭证体系）
        const credentials = await this.resolver.resolve()
        const ctx = await this.options.authStrategy.getAuthContext(credentials, {})
        const body = this.buildBody()
        const headers: Record<string, string> = {
          ...this.options.headers,
          ...ctx.headers,
        }
        // 有 body 才补 Content-Type：服务端 body parser 只解析 application/json，
        // 不补的话订阅 body 会被静默忽略（channels 落成默认 []）。body 为 null 时**不带**，
        // 且调用方显式设置的值一律不覆盖。
        if (body !== undefined && !hasHeader(headers, 'content-type')) {
          headers['Content-Type'] = 'application/json'
        }
        if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId

        const conn = streamConnectOnce(
          {
            url: this.options.url,
            method: this.options.method ?? 'POST',
            headers,
            body,
            signal,
            fetchImpl: this.options.fetch,
          },
          {
            onOpen: () => {
              // 连上就重置退避计数：否则 retryCount 只增不减，跨多次重连后即使只是偶发断线，
              // 也要等最长的退避间隔（maxRetryInterval）才重连。
              this.retryCount = 0
              this.setState(StreamClientState.Open)
            },
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
        // 服务端宣告排空（滚动更新 / 重启）：立即重连到其他实例。
        // 必须先于下面的「正常结束」判断 —— 服务端主动 end() 是正常结束，
        // 若按终态处理，每次滚动更新都会让长连接静默失效。
        if (this.serverShutdown) {
          this.serverShutdown = false
          this.retryCount = 0
          this.setState(StreamClientState.Reconnecting)
          await delay(this.options.retryInterval ?? 1000, this.controller?.signal)
          continue
        }
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

  /**
   * 构造请求体。
   *
   * `body === null` 视为「显式无请求体」（与 fetch 的 `body: null` 语义一致）：既不
   * `JSON.stringify(null)` 发出字面量 `"null"`，也不回落成 `{ channels }`；
   * 此时若不显式设置 Content-Type，请求就**不带** Content-Type。
   */
  private buildBody(): string | undefined {
    const { body, channels, method } = this.options
    if (body !== undefined) {
      return body === null ? undefined : JSON.stringify(body)
    }
    if ((method ?? 'POST').toUpperCase() === 'POST') {
      return JSON.stringify({ channels: channels ?? [] })
    }
    return undefined
  }

  private handleMessage(msg: StreamMessage): void {
    if (msg.id) this.lastEventId = msg.id
    // 排空宣告必须**独立于业务订阅者**记录：即使没人订阅这个事件名，
    // 也要影响流结束后的走向（下面分发给业务订阅者只是附带效果）
    if (msg.event === STREAM_SHUTDOWN_EVENT) this.serverShutdown = true
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

/** 大小写不敏感地判断请求头里是否已有某个头（headers 是普通对象，不是 Headers 实例）。 */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === target)
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
