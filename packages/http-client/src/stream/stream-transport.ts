import { StreamParser } from './stream-parser.js'
import { StreamTransportError } from './errors.js'
import type { StreamMessage } from './types.js'

/** 单次连接的回调。 */
export interface StreamConnectionCallbacks {
  /** 响应校验通过、开始读流（HTTP 200 + text/event-stream） */
  onOpen?(): void
  /** 解析出完整消息 */
  onMessage(message: StreamMessage): void
  /** 收到服务端 retry: 帧 */
  onRetry?(retry: number): void
  /** 服务端正常关闭流（非错误、非 abort） */
  onClose?(): void
}

/** 单次连接的请求参数。 */
export interface StreamConnectRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
}

/** 一次 SSE 连接句柄。 */
export interface StreamConnection {
  /**
   * 连接结束：
   * - 流正常读完 / 被 abort → resolve
   * - 出错（网络、非 SSE 响应等）→ reject
   */
  closed: Promise<void>
}

/**
 * 发起一次 SSE 连接并读取流，直到流结束、出错或 abort。
 * 只负责「单次连接」，不负责重连（重连由 HttpStreamClient 状态机控制）。
 * 跨环境：依赖浏览器 / Node 18+ 原生的 fetch、ReadableStream、TextDecoder。
 */
export function streamConnectOnce(
  request: StreamConnectRequest,
  callbacks: StreamConnectionCallbacks,
): StreamConnection {
  const { url, method = 'POST', headers, body, signal } = request
  const fetchImpl = request.fetchImpl ?? globalThis.fetch

  // Promise executor 同步执行，闭包运行前必被赋值
  let resolveClosed!: () => void
  let rejectClosed!: (err: unknown) => void
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve
    rejectClosed = reject
  })

  void (async () => {
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal,
      })

      if (!response.ok) {
        throw new StreamTransportError(`连接失败，HTTP ${response.status}`, {
          status: response.status,
        })
      }
      const contentType = response.headers.get('content-type')
      if (!contentType?.startsWith('text/event-stream')) {
        throw new StreamTransportError(
          `响应类型不是 text/event-stream，实际: ${contentType ?? '未知'}`,
        )
      }
      if (!response.body) {
        throw new StreamTransportError('响应没有可读的 body 流')
      }

      callbacks.onOpen?.()

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = new StreamParser({
        onMessage: (message) => callbacks.onMessage(message),
        onRetry: (retry) => callbacks.onRetry?.(retry),
      })

      for (;;) {
        if (signal.aborted) break
        const { done, value } = await reader.read()
        if (done) break
        parser.push(decoder.decode(value, { stream: true }))
      }
      parser.flush()

      if (signal.aborted) {
        // 主动中断：静默结束
        resolveClosed()
      } else {
        // 服务端正常关闭流
        callbacks.onClose?.()
        resolveClosed()
      }
    } catch (err) {
      if (signal.aborted) {
        // abort 引起的错误（AbortError 等）：静默结束
        resolveClosed()
      } else {
        rejectClosed(err)
      }
    }
  })()

  return { closed }
}
