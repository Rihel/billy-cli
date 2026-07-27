import { AppResponse, createMd5 } from '@repo/shared'
import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  CreateAxiosDefaults,
  isAxiosError,
} from 'axios'
import type { AuthStrategy, CredentialProvider, CredentialsManager } from './interfaces.js'
import { CredentialResolver } from './credential-resolver.js'
import { AuthInjector } from './auth-injector.js'

/** ApiClient 构造参数 */
export interface ApiClientOptions<Credentials = Record<string, any>> {
  /** 后端 API 基础地址 */
  baseUrl: string
  /** 凭证管理器：凭证存哪里 */
  credentialsManager: CredentialsManager<Credentials>
  /** 认证策略：凭证怎么用 */
  authStrategy: AuthStrategy<Credentials>
  /** 凭证供应器：凭证从哪来、怎么续期（可选。不传则不自动获取/刷新） */
  credentialProvider?: CredentialProvider<Credentials>
  /** Axios 创建选项 */
  axiosOptions?: CreateAxiosDefaults<any>
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
 *   3. 调用 axios 发起 HTTP 请求
 *   4. 处理错误（401 自动 refresh 重试）
 *
 * 不传 CredentialProvider 时等同于现有 Web 端行为，完全向后兼容。
 */
export class ApiClient<Credentials = Record<string, any>> {
  private readonly axiosInstance: AxiosInstance
  private readonly resolver: CredentialResolver<Credentials>
  private readonly injector: AuthInjector<Credentials>
  private readonly cancelPreviousMap: Map<string, AbortController> = new Map()

  constructor(private options: ApiClientOptions<Credentials>) {
    this.axiosInstance = axios.create({
      baseURL: this.options.baseUrl,
      ...this.options.axiosOptions,
    })
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

  /**
   * 发送请求。
   *
   * 请求流程：
   *   1. 非 skipAuth → CredentialResolver.resolve() 获取有效凭证
   *   2. AuthInjector.inject() 注入认证上下文
   *   3. cancelPrevious → 取消相同在途请求
   *   4. axios.request()
   *   5. 401 + 未重试过 + canRefresh → forceRefresh → 回到步骤 2 重试一次
   */
  protected async request<Body extends Record<string, any>, Res>(
    config: AxiosRequestConfig<Body>,
    requestOptions?: RequestOptions,
  ): Promise<AppResponse<Res>> {
    const { skipAuth, cancelPrevious } = requestOptions ?? {}

    if (!skipAuth) {
      // 步骤 1：获取有效凭证（内部含校验，失败抛错）
      await this.resolver.resolve()

      // 步骤 2：注入认证上下文
      const credentials = await this.options.credentialsManager.getCredentials()
      config = await this.injector.inject(config, credentials)
    }

    // 步骤 3：取消相同在途请求（显式启用）
    if (cancelPrevious) {
      const fingerprint = this.createFingerprint(config)
      const prev = this.cancelPreviousMap.get(fingerprint)
      if (prev) {
        prev.abort('检测到重复请求，已取消上一个。')
        this.cancelPreviousMap.delete(fingerprint)
      }

      const abortController = new AbortController()
      this.cancelPreviousMap.set(fingerprint, abortController)
      config = { ...config, signal: config.signal || abortController.signal }
    }

    // 步骤 4 + 5：发送请求 & 错误处理
    let retried = false

    try {
      const res = await this.axiosInstance.request<Res>(config)
      return res.data as AppResponse<Res>
    } catch (error) {
      // 401 → 刷新一次 → 重试
      if (
        !retried &&
        this.resolver.canRefresh &&
        isAxiosError(error) &&
        error.response?.status === 401
      ) {
        retried = true

        await this.resolver.forceRefresh()
        const fresh = await this.options.credentialsManager.getCredentials()
        const retryConfig = await this.injector.inject(config, fresh)
        const res = await this.axiosInstance.request<Res>(retryConfig)
        return res.data as AppResponse<Res>
      }

      this.options?.callbacks?.onError?.(error)
      throw error
    } finally {
      if (cancelPrevious && config.signal) {
        // 清理 cancelPreviousMap（通过 fingerprint 反向查找）
        // 由于 config 可能已被 injector 替换，用原始配置的指纹清理
        const fp = this.createFingerprint(config)
        this.cancelPreviousMap.delete(fp)
      }
    }
  }

  /** 基于 url + method + params + data 生成请求指纹 */
  private createFingerprint(config: AxiosRequestConfig): string {
    const str = JSON.stringify({
      url: config.url,
      method: config.method,
      params: config.params,
      data: config.data,
    })
    return createMd5(str)
  }
}
