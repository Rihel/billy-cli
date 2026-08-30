/** SSE 客户端错误基类。 */
export class StreamClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StreamClientError'
  }
}

/** SSE 传输层错误（响应非 SSE 流 / 连接失败等）。 */
export class StreamTransportError extends StreamClientError {
  /** HTTP 状态码（网络层错误时为 undefined） */
  readonly status?: number

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options)
    this.name = 'StreamTransportError'
    this.status = options?.status
  }
}
