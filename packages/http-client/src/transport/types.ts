import type { HttpRequestConfig } from '../core/interfaces.js'
import type { StreamMessage } from '../stream/types.js'

/** 低层传输选项（无凭证概念：鉴权 header 由调用方显式传入） */
export interface HttpTransportOptions {
  baseUrl?: string
  /** 默认请求头（每次请求合并） */
  headers?: Record<string, string>
  /** 默认整请求超时（仅 requestRaw；streamRaw 用 firstByteMs/idleMs） */
  timeoutMs?: number
  /** 自定义 fetch（测试注入 / 定制），默认全局 fetch */
  fetchImpl?: typeof fetch
}

export interface RequestRawOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface StreamRawOptions {
  /** 等响应头/首块的超时（毫秒）；<=0 关闭 */
  firstByteMs?: number
  /** 流中两次 chunk 之间的最大静默（毫秒）；<=0 关闭 */
  idleMs?: number
  signal?: AbortSignal
}

/** 一次性原始响应流（**不重连**；重连是 HttpStreamClient 的职责） */
export interface RawStream {
  status: number
  headers: Headers
  /** 原始字节流；调用方可直接 pipe 给下游（SSE 透传） */
  body: ReadableStream<Uint8Array>
  /** 中断上游（客户端断开 / 业务取消） */
  abort(reason?: string): void
  /** 逐行 JSON（NDJSON） */
  ndjson<T = unknown>(): AsyncIterable<T>
  /** 逐事件（SSE；data 为原始字符串） */
  sse(): AsyncIterable<StreamMessage>
}

/** requestRaw / streamRaw 的请求配置（复用 HttpClient 的字段命名） */
export type TransportRequest = HttpRequestConfig
