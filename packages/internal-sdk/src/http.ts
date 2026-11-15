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
}

export interface RequestOptions extends InvokeOptions {
  method?: 'GET' | 'POST'
  body?: unknown
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
  const timeoutMs = init.timeoutMs ?? options.timeoutMs ?? 30_000
  const transport = new HttpTransport({
    baseUrl: options.baseUrl,
    timeoutMs,
    fetchImpl: options.fetchImpl,
    headers: { 'x-internal-token': options.token },
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

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    if (init.signal?.aborted) throw new InternalAbortError()
    if ((error as { name?: string })?.name === 'AbortError') {
      throw new InternalTimeoutError(timeoutMs)
    }
    if (error instanceof ApiError && error.message === '请求超时') {
      throw new InternalTimeoutError(timeoutMs)
    }
    throw new InternalTransportError(error instanceof Error ? error.message : String(error), error)
  }
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new InternalProtocolError(parsed.error.issues)
  return parsed.data
}

/**
 * 读响应信封里的 `data`（Nest 侧的 `ResponseEnvelopeInterceptor` 统一包 `{ code, data }`）。
 *
 * 内部服务的业务接口都套了这层信封（`/internal/**`、tool-gateway / tool-worker 的业务路由）；
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

/** 由业务 schema 拼出 `{ code, data }` 信封 schema（`code` 只校验形状，成功路径固定 0） */
const envelopeSchema = <T>(schema: ZodType<T>) =>
  z.object({
    code: z.number(),
    data: schema,
  })
