import { ApiError, ApiErrorCodes } from '../core/api-error.js'
import { buildRequestUrl } from '../core/url.js'
import { StreamParser } from '../stream/stream-parser.js'
import type { StreamMessage } from '../stream/types.js'
import type {
  HttpTransportOptions,
  RawStream,
  RequestRawOptions,
  StreamRawOptions,
  TransportRequest,
} from './types.js'

/**
 * 无凭证的一次性 HTTP 传输层。
 *
 * 与 `HttpClient` 的分工：
 * - `HttpClient`：业务 API 客户端（凭证、401 刷新、AppResponse 解包、cancelPrevious）；
 * - `HttpTransport`：原始请求/响应（不解析 JSON、非 2xx 不抛、SSE/NDJSON 逐块消费），
 *   给网关代理、服务间调用、流式转换这类场景用。
 *
 * 鉴权不在这里做：调用方把 token 放进 `headers`（如 `x-internal-token` / `Authorization`）。
 * `HttpStreamClient`（自动重连的 SSE 订阅）与本类不重叠：本类是一次性请求/流，永不重连。
 */
export class HttpTransport {
  constructor(private readonly options: HttpTransportOptions = {}) {}

  /** 原始 Response：**非 2xx 不抛**，由调用方看 status/body；网络/超时才抛。 */
  async requestRaw(config: TransportRequest, options: RequestRawOptions = {}): Promise<Response> {
    const url = this.urlOf(config)
    const headers = this.headersOf(config.headers)
    const { body, duplex } = prepareBody(config.data, headers)
    const { signal, cleanup } = withTimeout(
      options.signal ?? config.signal,
      options.timeoutMs ?? config.timeout ?? this.options.timeoutMs,
    )
    const fetchImpl = this.options.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: config.method ?? 'GET',
        headers,
        body,
        signal,
        ...(duplex ? { duplex } : {}),
      } as RequestInit)
    } catch (error) {
      cleanup()
      throw toTransportError(error, url, config.method ?? 'GET', signal)
    }
    const timeoutMs = options.timeoutMs ?? config.timeout ?? this.options.timeoutMs
    if (!response.body || !timeoutMs || timeoutMs <= 0) {
      cleanup()
      return response
    }
    // 超时覆盖到响应体：否则「响应头很快、body 卡死」会永久挂住（内部 JSON 调用）。
    // timer 在 body 关闭 / 出错 / 取消时清理；超时由上面的 signal abort 传播成读取错误。
    const bodyStream = withBodyTimeout(response.body as ReadableStream<Uint8Array>, signal, cleanup)
    return new Response(bodyStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  /**
   * 打开一次性原始流：返回 `RawStream`（status/headers/body + ndjson()/sse()）。
   *
   * - `firstByteMs`：等响应头的超时；超时 abort 上游并抛错；
   * - `idleMs`：消费过程中两次 chunk 的静默上限；超时中断流并让读取抛错；
   * - **没有整请求 timeout**：流式不能用总超时掐断。
   */
  async streamRaw(config: TransportRequest, options: StreamRawOptions = {}): Promise<RawStream> {
    const url = this.urlOf(config)
    const headers = this.headersOf(config.headers)
    const { body, duplex } = prepareBody(config.data, headers)
    const controller = new AbortController()
    const offExternal = linkAbort(options.signal ?? config.signal, controller)
    const firstByteMs = options.firstByteMs ?? 0
    const firstByteTimer =
      firstByteMs > 0 ? setTimeout(() => controller.abort('首字节超时'), firstByteMs) : undefined
    const fetchImpl = this.options.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: config.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
        ...(duplex ? { duplex } : {}),
      } as RequestInit)
    } catch (error) {
      offExternal()
      throw toTransportError(error, url, config.method ?? 'GET', controller.signal)
    } finally {
      if (firstByteTimer) clearTimeout(firstByteTimer)
    }
    if (!response.body) {
      offExternal()
      throw new ApiError(ApiErrorCodes.InternalError, '上游没有可读的响应体', {
        status: response.status,
        details: { url },
      })
    }
    return new HttpResponseStream(response, controller, options.idleMs ?? 0, offExternal)
  }

  private urlOf(config: TransportRequest): string {
    return buildRequestUrl(this.options.baseUrl ?? '', config.url, config.params)
  }

  private headersOf(extra?: Record<string, string | undefined>): Headers {
    const headers = new Headers(this.options.headers)
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (value === undefined || value === null) continue
      headers.set(key, String(value))
    }
    return headers
  }
}

/** 一次性响应流实现：原始 body + SSE/NDJSON 解码 + 空闲中断 */
class HttpResponseStream implements RawStream {
  readonly status: number
  readonly headers: Headers
  readonly body: ReadableStream<Uint8Array>

  constructor(
    response: Response,
    private readonly controller: AbortController,
    idleMs: number,
    private readonly offExternal: () => void,
  ) {
    this.status = response.status
    this.headers = response.headers
    const source = response.body as ReadableStream<Uint8Array>
    this.body = idleMs > 0 ? withIdleTimeout(source, idleMs, controller) : source
  }

  abort(reason = '已取消'): void {
    this.controller.abort(reason)
    this.offExternal()
  }

  ndjson<T = unknown>(): AsyncIterable<T> {
    return readNdjson<T>(this.body)
  }

  sse(): AsyncIterable<StreamMessage> {
    return readSse(this.body)
  }
}

/** 请求体：流原样透传（half duplex）；普通对象 JSON 序列化。 */
const prepareBody = (data: unknown, headers: Headers): { body?: BodyInit; duplex?: 'half' } => {
  if (data === undefined || data === null) return {}
  if (isReadableStream(data)) {
    return { body: data as BodyInit, duplex: 'half' }
  }
  if (typeof data === 'string') return { body: data }
  if (
    (typeof FormData !== 'undefined' && data instanceof FormData) ||
    (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) ||
    (typeof Blob !== 'undefined' && data instanceof Blob) ||
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data)
  ) {
    return { body: data as BodyInit }
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  return { body: JSON.stringify(data) }
}

/** 组合外部 signal 与超时（本地实现，避免为了一个 timer 引依赖） */
const withTimeout = (
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal?: AbortSignal; cleanup: () => void } => {
  if (!timeoutMs || timeoutMs <= 0) return { signal, cleanup: () => {} }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('请求超时'), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason ?? '已取消')
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

const linkAbort = (signal: AbortSignal | undefined, controller: AbortController): (() => void) => {
  if (!signal) return () => {}
  if (signal.aborted) {
    controller.abort(signal.reason)
    return () => {}
  }
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

const toTransportError = (
  error: unknown,
  url: string,
  method: string,
  signal?: AbortSignal,
): ApiError => {
  const reason = typeof signal?.reason === 'string' ? signal.reason : ''
  if (reason.includes('超时')) {
    return new ApiError(ApiErrorCodes.NetworkError, '请求超时', {
      details: { url, method, cause: reason },
    })
  }
  if (reason) {
    return new ApiError(ApiErrorCodes.NetworkError, '请求已取消', {
      details: { url, method, cause: reason },
    })
  }
  if ((error as { name?: string })?.name === 'TimeoutError') {
    return new ApiError(ApiErrorCodes.NetworkError, '请求超时', {
      details: { url, method },
    })
  }
  if ((error as { name?: string })?.name === 'AbortError') {
    return new ApiError(ApiErrorCodes.NetworkError, '请求已取消', {
      details: { url, method },
    })
  }
  return new ApiError(ApiErrorCodes.NetworkError, '网络异常，无法连接到服务器', {
    details: { url, method, cause: (error as Error)?.message ?? 'UNKNOWN' },
  })
}

const isReadableStream = (value: unknown): value is ReadableStream<Uint8Array> =>
  typeof ReadableStream !== 'undefined' && value instanceof ReadableStream

/** 空闲超时：每次 read 前重置计时；超时中断上游并让当前读取报错。 */
const withIdleTimeout = (
  source: ReadableStream<Uint8Array>,
  idleMs: number,
  controller: AbortController,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      const timer = setTimeout(() => {
        controller.abort('空闲超时')
        stream.error(
          new ApiError(ApiErrorCodes.NetworkError, '上游空闲超时', {
            details: { idleMs },
          }),
        )
      }, idleMs)
      try {
        const { done, value } = await reader.read()
        clearTimeout(timer)
        if (done) stream.close()
        else stream.enqueue(value)
      } catch (error) {
        clearTimeout(timer)
        stream.error(error)
      }
    },
    cancel(reason) {
      controller.abort('已取消')
      return reader.cancel(reason)
    },
  })
}

/** NDJSON：逐行 JSON.parse（跨 chunk 粘行）；空行跳过。 */
async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line.trim()) yield parseLine<T>(line)
      }
    }
    buffer += decoder.decode()
    const last = buffer.trim()
    if (last) yield parseLine<T>(last)
  } finally {
    reader.releaseLock()
  }
}

const parseLine = <T>(line: string): T => {
  try {
    return JSON.parse(line) as T
  } catch (cause) {
    throw new ApiError(ApiErrorCodes.InternalError, 'NDJSON 解析失败', {
      details: { line: line.slice(0, 200), cause: (cause as Error)?.message },
    })
  }
}

/** SSE：复用 StreamParser，把回调转成 async generator（保持与客户端解析同一套语义）。 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<StreamMessage> {
  const queue: StreamMessage[] = []
  const parser = new StreamParser({ onMessage: (message) => queue.push(message) })
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.push(decoder.decode(value, { stream: true }))
      while (queue.length) yield queue.shift() as StreamMessage
    }
    parser.flush()
    while (queue.length) yield queue.shift() as StreamMessage
  } finally {
    reader.releaseLock()
  }
}

/** 保持 requestRaw 的超时计时直到响应体被消费完（关闭 / 出错 / 取消时清理） */
const withBodyTimeout = (
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  cleanup: () => void,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader()
  let aborted = false
  const finish = (): void => {
    cleanup()
    signal?.removeEventListener('abort', onAbort)
  }
  const onAbort = (): void => {
    aborted = true
    void reader.cancel(signal?.reason)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  return new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          finish()
          if (aborted) {
            stream.error(
              new ApiError(ApiErrorCodes.NetworkError, '请求超时', {
                details: { cause: signal?.reason },
              }),
            )
          } else {
            stream.close()
          }
        } else {
          stream.enqueue(value)
        }
      } catch (error) {
        finish()
        stream.error(error)
      }
    },
    cancel(reason) {
      finish()
      return reader.cancel(reason)
    },
  })
}
