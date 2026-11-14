import type { ZodType } from 'zod'
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

interface RequestOptions extends InvokeOptions {
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
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = init.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal
  const url = `${options.baseUrl.replace(/\/+$/, '')}${path}`
  const hasBody = init.body !== undefined

  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: init.method ?? 'GET',
      headers: {
        'x-internal-token': options.token,
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      signal,
    })
  } catch (error) {
    if (init.signal?.aborted) throw new InternalAbortError()
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new InternalTimeoutError(timeoutMs)
    }
    throw new InternalTransportError(error instanceof Error ? error.message : String(error), error)
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500)
    throw new InternalApiError(response.status, detail)
  }

  const payload = (await response.json().catch(() => null)) as unknown
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new InternalProtocolError(parsed.error.issues)
  return parsed.data
}
