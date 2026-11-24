import { z, type ZodType } from 'zod'
import { ApiError, HttpTransport } from '@repo/http-client'
import {
  InternalAbortError,
  InternalApiError,
  InternalProtocolError,
  InternalTimeoutError,
  InternalTransportError,
} from './errors.js'

/** 内部服务客户端的公共配置 */
export interface InternalClientOptions {
  baseUrl: string
  /** 内部服务令牌（服务间短期令牌 / 本地共享令牌） */
  token: string
  /** 默认超时；单次调用可覆盖 */
  timeoutMs?: number
  /** 测试注入用；生产用全局 fetch */
  fetchImpl?: typeof fetch
}

/** 单次调用的覆盖项 */
export interface InvokeOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** 追加请求头（身份头 / 追踪 id）；同名时覆盖默认头 */
  headers?: Record<string, string | undefined>
}

export interface RequestOptions extends InvokeOptions {
  method?: 'GET' | 'POST'
  body?: unknown
}

/**
 * 流式请求的覆盖项。
 *
 * 流式**没有整请求超时**（长思考可能很久没输出）：只有等响应头的 `firstByteMs`
 * 与两次 chunk 之间的 `idleMs` 两个闸。
 */
export interface StreamRequestOptions extends InvokeOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  /** 等响应头的上限（毫秒）；<= 0 关闭，默认 30s —— 防上游卡死 */
  firstByteMs?: number
  /** 两次 chunk 之间的静默上限（毫秒）；<= 0 关闭（默认关闭） */
  idleMs?: number
}

/** 一次性打开的原始流；`body` 为 null 表示上游没给响应体（204 / 空体） */
export interface OpenStreamResult {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
  /** 中断上游（客户端断开 / 业务取消） */
  abort(reason?: string): void
}

/** 默认整请求超时（与改造前保持一致） */
const DEFAULT_TIMEOUT_MS = 30_000
/** 流式默认首字节超时 */
const DEFAULT_FIRST_BYTE_MS = 30_000

/** 拼请求头：内部令牌 + 本次覆盖（`undefined` 视为不设置） */
const buildHeaders = (
  options: InternalClientOptions,
  extra?: Record<string, string | undefined>,
): Record<string, string> => {
  const headers: Record<string, string> = { 'x-internal-token': options.token }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) continue
    headers[key] = value
  }
  return headers
}

/**
 * 发一次 JSON 请求并做非 2xx 映射。
 *
 * 不解析响应体：204（无内容）这类没有 body 的状态要先由调用方判断，
 * 否则会被当成"响应不符合契约"。
 */
const performRequest = async (
  options: InternalClientOptions,
  path: string,
  init: RequestOptions,
): Promise<{ response: Response; timeoutMs: number }> => {
  const timeoutMs = init.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const transport = new HttpTransport({
    baseUrl: options.baseUrl,
    timeoutMs,
    fetchImpl: options.fetchImpl,
    headers: buildHeaders(options, init.headers),
  })
  const hasBody = init.body !== undefined

  let response: Response
  try {
    response = await transport.requestRaw(
      {
        url: path,
        method: init.method ?? 'GET',
        headers: hasBody ? { 'content-type': 'application/json' } : undefined,
        data: hasBody ? init.body : undefined,
        signal: init.signal,
      },
      { timeoutMs },
    )
  } catch (error) {
    if (init.signal?.aborted) throw new InternalAbortError()
    if (error instanceof ApiError) {
      if (error.message === '请求超时') throw new InternalTimeoutError(timeoutMs)
      if (error.message === '请求已取消') throw new InternalAbortError()
    }
    throw new InternalTransportError(error instanceof Error ? error.message : String(error), error)
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500)
    throw new InternalApiError(response.status, detail)
  }
  return { response, timeoutMs }
}

/**
 * 读响应体 JSON。
 *
 * `invalidBodyAsNull`：响应体为空 / 被截断时返回 `null` 而不是抛错。
 * 只给「本来就可能没有内容」的接口用（如快照：200 + 空体 = 这次没有快照），
 * 普通接口仍按契约错误上报。
 */
const parseJson = async (
  response: Response,
  init: RequestOptions,
  timeoutMs: number,
  invalidBodyAsNull: boolean,
): Promise<unknown> => {
  try {
    return await response.json()
  } catch (error) {
    if (init.signal?.aborted) throw new InternalAbortError()
    if ((error as { name?: string })?.name === 'AbortError') {
      throw new InternalTimeoutError(timeoutMs)
    }
    if (error instanceof ApiError && error.message === '请求超时') {
      throw new InternalTimeoutError(timeoutMs)
    }
    if (invalidBodyAsNull) return null
    throw new InternalTransportError(error instanceof Error ? error.message : String(error), error)
  }
}

/**
 * 内部 API 的 JSON 请求收口（**所有 app 间调用都走这里**）。
 *
 * 负责：URL 拼接、令牌、超时 / 取消合并、非 2xx 映射、响应契约校验。
 * 不负责重试：是否重试取决于工具是否幂等，交给调用方决定。
 */
export const requestJson = async <T>(
  options: InternalClientOptions,
  path: string,
  schema: ZodType<T>,
  init: RequestOptions = {},
): Promise<T> => {
  const { response, timeoutMs } = await performRequest(options, path, init)
  const payload = await parseJson(response, init, timeoutMs, false)
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new InternalProtocolError(parsed.error.issues)
  return parsed.data
}

/**
 * 可空 JSON：`204` 与空 / 残缺响应体一律视为 `null`。
 *
 * 用于「有没有」本身就是答案的接口（进行中的运行快照）：上游用 204 表达"没有"，
 * 中间层还可能截断 body —— 这两种都不该报成 500。
 */
export const requestJsonOptional = async <T>(
  options: InternalClientOptions,
  path: string,
  schema: ZodType<T>,
  init: RequestOptions = {},
): Promise<T | null> => {
  const { response, timeoutMs } = await performRequest(options, path, init)
  if (response.status === 204) return null
  const payload = await parseJson(response, init, timeoutMs, true)
  if (payload === null) return null
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new InternalProtocolError(parsed.error.issues)
  return parsed.data
}

/**
 * 读响应信封里的 `data`（Nest 侧的 `ResponseEnvelopeInterceptor` 统一包 `{ code, data }`）。
 *
 * 内部服务的业务接口都套了这层信封（`/internal/**`、capability-gateway / common-capability 的业务路由）；
 * 只有 healthz / readyz 探针保持裸 JSON（`requestJson`）。两种约定分开写，避免调用方自己再脱壳。
 */
export const requestEnvelope = async <T>(
  options: InternalClientOptions,
  path: string,
  schema: ZodType<T>,
  init: RequestOptions = {},
): Promise<T> => {
  const payload = await requestJson(options, path, envelopeSchema(schema), init)
  return payload.data
}

/**
 * 打开一次性原始流（SSE 透传用）：只负责建立连接与错误归一，**不解析帧**。
 *
 * 帧的解析按用途分流：main 的 `/agent/*` 中转是把字节流读掉、内容走 pub/sub；
 * 需要逐帧消费的调用方可以自己包 `HttpStreamClient`。
 *
 * 上游没有可读响应体（204 没有内容 / 5xx 空体）时返回 `body: null` 与真实状态码，
 * 由调用方决定对外怎么响应（透传 204、映射 502 等）。
 */
export const openStream = async (
  options: InternalClientOptions,
  path: string,
  init: StreamRequestOptions = {},
): Promise<OpenStreamResult> => {
  const firstByteMs = init.firstByteMs ?? DEFAULT_FIRST_BYTE_MS
  const transport = new HttpTransport({
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    headers: buildHeaders(options, init.headers),
  })
  const hasBody = init.body !== undefined

  try {
    const stream = await transport.streamRaw(
      {
        url: path,
        method: init.method ?? 'GET',
        headers: hasBody ? { 'content-type': 'application/json' } : undefined,
        data: hasBody ? init.body : undefined,
        signal: init.signal,
      },
      {
        firstByteMs,
        idleMs: init.idleMs ?? 0,
        signal: init.signal,
      },
    )
    return {
      status: stream.status,
      headers: stream.headers,
      body: stream.body,
      abort: (reason?: string) => stream.abort(reason),
    }
  } catch (error) {
    if (init.signal?.aborted) throw new InternalAbortError()
    // 上游没有响应体：`streamRaw` 会带真实状态码抛错，这里归一成"只有状态"的结果
    if (error instanceof ApiError && typeof error.status === 'number') {
      return { status: error.status, headers: new Headers(), body: null, abort: () => {} }
    }
    if (error instanceof ApiError) {
      if (error.message === '请求超时') throw new InternalTimeoutError(firstByteMs)
      if (error.message === '请求已取消') throw new InternalAbortError()
    }
    throw new InternalTransportError(error instanceof Error ? error.message : String(error), error)
  }
}

/** 由业务 schema 拼出 `{ code, data }` 信封 schema（`code` 只校验形状，成功路径固定 0） */
const envelopeSchema = <T>(schema: ZodType<T>) =>
  z.object({
    code: z.number(),
    data: schema,
  })
