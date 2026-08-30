import { AppResponse, createMd5, ResponseUtils } from '@repo/shared'
import type {
  AuthStrategy,
  CredentialProvider,
  CredentialsManager,
  HttpRequestConfig,
} from './interfaces.js'
import {
  ApiError,
  ApiErrorCodes,
  mapHttpStatus,
  mapAppErrorValue,
} from './api-error.js'
import { CredentialResolver } from './credential-resolver.js'
import { AuthInjector } from './auth-injector.js'

/** HttpClient 构造参数 */
export interface HttpClientOptions<Credentials = Record<string, any>> {
  /** 后端 API 基础地址 */
  baseUrl: string
  /** 凭证管理器：凭证存哪里 */
  credentialsManager: CredentialsManager<Credentials>
  /** 认证策略：凭证怎么用 */
  authStrategy: AuthStrategy<Credentials>
  /** 凭证供应器：凭证从哪来、怎么续期（可选。不传则不自动获取/刷新） */
  credentialProvider?: CredentialProvider<Credentials>
  /**
   * 用户体系开关（默认 true，向后兼容）。
   * false 时所有请求跳过凭证解析与注入（等价于 skipAuth），
   * 鉴权与否完全交由后端守卫判断 —— 用于用户体系由外部服务提供、
   * 或自用工具不需要用户体系的场景。
   */
  authEnabled?: boolean
  /** fetch 默认选项（如 credentials: 'include'），合并到每次请求 */
  fetchOptions?: RequestInit
  /** 回调钩子 */
  callbacks?: Partial<{
    /** 凭证无效时调用 */
    onUnauthorized: () => Promise<void>
    /** 请求失败时调用 */
    onError: (error: any) => Promise<void>
  }>
}

/** 请求选项 */
export interface RequestOptions {
  /** 跳过认证流程。用于登录、注册等公开接口。 */
  skipAuth?: boolean
  /**
   * 取消相同在途请求（cancel previous, latest wins）。
   * 相同 url + method + params + data 的请求在途时，取消前一个。
   */
  cancelPrevious?: boolean
}

/**
 * 带认证的 HTTP 客户端。
 *
 * 职责：
 *   1. 接收请求配置
 *   2. 编排认证流程（CredentialResolver → AuthInjector）
 *   3. 调用 fetch 发起 HTTP 请求
 *   4. 处理错误（401 自动 refresh 重试，统一以 ApiError 输出）
 *
 * 不传 CredentialProvider 时等同于现有 Web 端行为，完全向后兼容。
 */
export class HttpClient<Credentials = Record<string, any>> {
  private readonly resolver: CredentialResolver<Credentials>
  private readonly injector: AuthInjector<Credentials>
  private readonly cancelPreviousMap: Map<string, AbortController> = new Map()
  /** 用户体系开关（默认 true）；false 时所有请求等价 skipAuth */
  private authEnabled: boolean

  constructor(private options: HttpClientOptions<Credentials>) {
    this.authEnabled = options.authEnabled ?? true
    this.resolver = new CredentialResolver(
      options.credentialsManager,
      options.authStrategy,
      options.credentialProvider,
    )
    this.injector = new AuthInjector(options.authStrategy)
  }

  /** 获取凭证管理器 */
  get credentialsManager() {
    return this.options.credentialsManager
  }

  /** 获取认证策略 */
  get authStrategy() {
    return this.options.authStrategy
  }

  /** 设置用户体系开关（运行时切换：关闭后所有请求跳过认证，交由后端守卫判断）。 */
  setAuthEnabled(enabled: boolean): void {
    this.authEnabled = enabled
  }

  /**
   * 发送请求。
   *
   * 请求流程：
   *   1. 非 skipAuth 且用户体系开启 → CredentialResolver.resolve() 获取有效凭证
   *   2. AuthInjector.inject() 注入认证上下文
   *   3. cancelPrevious → 取消相同在途请求
   *   4. fetch() 发送请求
   *   5. 401 + 未重试过 + canRefresh → forceRefresh → 回到步骤 2 重试一次
   *
   * 所有错误统一以 ApiError 抛出，支持 JSON 序列化。
   */
  async request<Body extends Record<string, any>, Res>(
    config: HttpRequestConfig<Body>,
    requestOptions?: RequestOptions,
  ): Promise<AppResponse<Res>> {
    const { skipAuth, cancelPrevious } = requestOptions ?? {}

    let finalConfig: HttpRequestConfig<Body> = config

    // 用户体系开关关闭时跳过凭证解析与注入（等价于 skipAuth），交由后端守卫判断
    const effectiveSkipAuth = skipAuth || !this.authEnabled
    if (!effectiveSkipAuth) {
      // 步骤 1：获取有效凭证（内部含校验，失败抛 ApiError）
      await this.resolver.resolve()

      // 步骤 2：注入认证上下文
      const credentials = await this.options.credentialsManager.getCredentials()
      finalConfig = await this.injector.inject(config, credentials)
    }

    // 步骤 3：取消相同在途请求（显式启用）
    if (cancelPrevious) {
      const fingerprint = this.createFingerprint(finalConfig)
      const prev = this.cancelPreviousMap.get(fingerprint)
      if (prev) {
        prev.abort('检测到重复请求，已取消上一个。')
        this.cancelPreviousMap.delete(fingerprint)
      }

      const abortController = new AbortController()
      this.cancelPreviousMap.set(fingerprint, abortController)
      finalConfig = {
        ...finalConfig,
        signal: finalConfig.signal || abortController.signal,
      }
    }

    // 步骤 4 + 5：发送请求 & 错误处理
    let retried = false

    try {
      return await this.executeFetch<Res>(finalConfig)
    } catch (error) {
      // 401 → 刷新一次 → 重试
      if (
        !retried &&
        this.resolver.canRefresh &&
        error instanceof ApiError &&
        error.status === 401
      ) {
        retried = true

        await this.resolver.forceRefresh()
        const fresh = await this.options.credentialsManager.getCredentials()
        const retryConfig = await this.injector.inject(config, fresh)
        return await this.executeFetch<Res>(retryConfig)
      }

      this.options?.callbacks?.onError?.(error)
      throw this.normalizeError(error)
    } finally {
      if (cancelPrevious && finalConfig.signal) {
        const fp = this.createFingerprint(finalConfig)
        this.cancelPreviousMap.delete(fp)
      }
    }
  }

  /**
   * 发送需要鉴权的 POST 请求。
   * 自动解包 AppResponse，业务错误（code !== 0）时抛 ApiError。
   */
  async post<Res, Body extends Record<string, any> = Record<string, any>>(
    endpoint: string,
    body?: Body,
    requestOptions?: RequestOptions,
  ): Promise<Res> {
    const response = await this.request<Body, Res>(
      {
        method: 'POST',
        url: endpoint,
        data: body,
      },
      requestOptions,
    )
    if (ResponseUtils.isError(response)) {
      throw new ApiError(
        mapAppErrorValue(response.code),
        response.message || '请求失败',
        {
          status: response.code,
          details: { response },
        },
      )
    }
    return response.data as Res
  }

  /**
   * 通过 fetch 发送请求并解析响应。
   * - 网络层失败（断网 / DNS / 超时 / 被取消）→ 抛 NetworkError ApiError
   * - HTTP 非 2xx → 抛对应状态码映射的 ApiError
   * - HTTP 2xx → 解析 JSON 返回 AppResponse
   */
  private async executeFetch<Res>(
    config: HttpRequestConfig,
  ): Promise<AppResponse<Res>> {
    const { url, method = 'GET', params, data, signal, timeout } = config
    const fullUrl = this.buildUrl(url, params)

    // 合并默认头（fetchOptions.headers）+ 请求头
    const requestHeaders = new Headers(this.options.fetchOptions?.headers)
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      if (value === undefined || value === null) continue
      requestHeaders.set(key, String(value))
    }

    // 组合外部 signal 与超时
    const { signal: finalSignal, cleanup } = this.withTimeout(signal, timeout)

    let body: BodyInit | undefined
    if (data !== undefined && data !== null) {
      body = this.serializeBody(data, requestHeaders)
    }

    let response: Response
    try {
      response = await fetch(fullUrl, {
        ...this.options.fetchOptions,
        method,
        headers: requestHeaders,
        body,
        signal: finalSignal,
      })
    } catch (error) {
      throw this.normalizeFetchError(error, fullUrl, method, finalSignal)
    } finally {
      cleanup()
    }

    // HTTP 非 2xx → 业务异常
    if (!response.ok) {
      const responseData = await this.safeParseJson(response)
      throw new ApiError(
        mapHttpStatus(response.status),
        responseData?.message || `请求失败（HTTP ${response.status}）`,
        {
          status: response.status,
          details: {
            url: fullUrl,
            method,
            responseData,
          },
        },
      )
    }

    // HTTP 2xx → 解析 JSON
    const text = await response.text()
    if (!text) {
      return undefined as unknown as AppResponse<Res>
    }
    try {
      return JSON.parse(text) as AppResponse<Res>
    } catch {
      throw new ApiError(
        ApiErrorCodes.InternalError,
        '响应解析失败：服务器返回了非 JSON 内容',
        {
          status: response.status,
          details: { url: fullUrl, method },
        },
      )
    }
  }

  /**
   * 拼接 baseUrl + path + 查询参数。
   * 自动处理：
   *   - baseUrl 可带 path（如 https://api.test/api/v1），请求路径拼在其后
   *   - baseUrl 尾斜杠归一化（不会出现双斜杠）
   *   - path 自带查询串时与 params 以 & 合并（不会出现双问号）
   *   - url 为完整 URL 时直接使用，不再拼 baseUrl
   */
  private buildUrl(path: string, params?: Record<string, any>): string {
    const url = this.resolveUrl(path)
    this.appendSearchParams(url, params)
    return url.toString()
  }

  /** 解析请求 URL：完整 URL 直接使用；相对路径拼接在 baseUrl 的 path 之后 */
  private resolveUrl(path: string): URL {
    // 完整 URL（含 scheme）或协议相对 URL（//）直接解析
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(path) || path.startsWith('//')) {
      return new URL(path, this.options.baseUrl)
    }
    const url = new URL(this.options.baseUrl)
    const basePath = url.pathname.replace(/\/+$/, '')
    // 补前导斜杠后按根相对解析，拆分 path 自带的查询串 / hash，
    // 避免被 pathname 转义，也避免依赖 baseUrl 是否带尾斜杠的相对解析差异
    const parsed = new URL(
      path.startsWith('/') ? path : `/${path}`,
      this.options.baseUrl,
    )
    url.pathname = `${basePath}${parsed.pathname}`
    if (parsed.search) url.search = parsed.search
    if (parsed.hash) url.hash = parsed.hash
    return url
  }

  /** 将查询参数写入 URL：过滤 undefined/null、数组展开为重复键、对象 JSON 序列化 */
  private appendSearchParams(url: URL, params?: Record<string, any>): void {
    if (!params) return
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === undefined || item === null) continue
          url.searchParams.append(key, this.serializeParam(item))
        }
        continue
      }
      url.searchParams.append(key, this.serializeParam(value))
    }
  }

  /** 查询参数值序列化：对象 JSON 编码，其余转字符串 */
  private serializeParam(value: unknown): string {
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  }

  /** 序列化请求体；普通对象自动 JSON 序列化并补 Content-Type */
  private serializeBody(data: any, headers: Headers): BodyInit | undefined {
    if (typeof data === 'string') return data
    if (
      data instanceof FormData ||
      data instanceof URLSearchParams ||
      data instanceof Blob ||
      data instanceof ArrayBuffer ||
      ArrayBuffer.isView(data)
    ) {
      return data as BodyInit
    }
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    return JSON.stringify(data)
  }

  /** 组合外部 signal 与超时定时器，返回最终 signal 与清理函数 */
  private withTimeout(
    signal?: AbortSignal,
    timeout?: number,
  ): { signal?: AbortSignal; cleanup: () => void } {
    if (!timeout || timeout <= 0) {
      return { signal, cleanup: () => {} }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort('请求超时'), timeout)
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

  /**
   * fetch 只在网络层失败时 reject（断网 / DNS / 超时 / 被取消），
   * HTTP 状态码错误会正常 resolve，在 executeFetch 中处理。
   */
  private normalizeFetchError(
    error: any,
    url: string,
    method: string,
    signal?: AbortSignal,
  ): ApiError {
    if (error?.name === 'AbortError') {
      const reason = signal?.reason
      const reasonText =
        typeof reason === 'string' && reason ? reason : 'ABORTED'
      return new ApiError(
        ApiErrorCodes.NetworkError,
        reasonText === '请求超时' ? '请求超时' : '请求已取消',
        {
          details: { url, method, cause: reasonText },
        },
      )
    }
    return new ApiError(
      ApiErrorCodes.NetworkError,
      '网络异常，无法连接到服务器',
      {
        details: {
          url,
          method,
          cause: error?.message || 'UNKNOWN',
        },
      },
    )
  }

  /** 将任意错误转为 ApiError，保证统一异常结构 */
  private normalizeError(error: any): ApiError {
    if (error instanceof ApiError) return error
    return new ApiError(
      ApiErrorCodes.InternalError,
      error?.message || '未知错误',
      { details: error },
    )
  }

  /** 基于 url + method + params + data 生成请求指纹 */
  private createFingerprint(config: HttpRequestConfig): string {
    const str = JSON.stringify({
      url: config.url,
      method: config.method,
      params: config.params,
      data: config.data,
    })
    return createMd5(str)
  }

  /** 安全解析响应 JSON，解析失败返回 undefined */
  private async safeParseJson(response: Response): Promise<any> {
    const text = await response.text()
    if (!text) return undefined
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
}
