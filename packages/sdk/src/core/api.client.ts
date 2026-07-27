import { AppResponse, createMd5 } from '@repo/shared'
import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  CreateAxiosDefaults,
} from 'axios'
import _ from 'lodash'
import type { AuthStrategy, CredentialsManager } from './interfaces.js'

export interface ApiClientOptions<Credentials = Record<string, any>> {
  baseUrl: string
  credentialsManager: CredentialsManager<Credentials>
  authStrategy: AuthStrategy<Credentials>
  axiosOptions?: CreateAxiosDefaults<any>
  callbacks?: Partial<{
    onUnauthorized: () => Promise<void>
    onError: (error: any) => Promise<void>
  }>
}

export class ApiClient<Credentials = Record<string, any>> {
  private readonly axiosInstance: AxiosInstance
  private abortMap: Map<string, AbortController> = new Map()
  constructor(private options: ApiClientOptions<Credentials>) {
    this.axiosInstance = axios.create({
      baseURL: this.options.baseUrl,
      ...this.options.axiosOptions,
    })
  }
  get credentialsManager() {
    return this.options.credentialsManager
  }
  get authStrategy() {
    return this.options.authStrategy
  }

  protected async request<Body extends Record<string, any>, Res>(
    config: AxiosRequestConfig<Body> & { skipAuth?: boolean },
  ): Promise<AppResponse<Res>> {
    const skipAuth = config.skipAuth
    delete (config as any).skipAuth

    if (!skipAuth) {
      // 1. 鉴权校验
      const credentials = await this.credentialsManager.getCredentials()
      const isAuthorized = await this.authStrategy.isAuthorization(credentials)
      if (!isAuthorized) {
        await this.options?.callbacks?.onUnauthorized?.()
        throw new Error(
          'Unauthorized: Invalid credentials or authorization failed.',
        )
      }

      // 2. 注入鉴权上下文
      const authContext = await this.authStrategy.getAuthContext(credentials)

      config.headers = {
        ...config.headers,
        ...(authContext.headers || {}),
      }
      config.params = {
        ...config.params,
        ...(authContext.query || {}),
      }
      config.data = authContext.body
        ? { ...config.data, ...authContext.body }
        : config.data
    }

    const mergedConfig: AxiosRequestConfig<Body> = {
      ...config,
    }

    // 3. 处理重复请求与取消逻辑 (AbortController)
    const requestId = this.createRequestId(mergedConfig)

    // 如果之前的相同请求还在进行中，取消上一次请求（按需决定是否开启）
    if (this.abortMap.has(requestId)) {
      this.abortMap.get(requestId)?.abort('Duplicate request cancelled.')
      this.abortMap.delete(requestId)
    }

    const abortController = new AbortController()
    this.abortMap.set(requestId, abortController)

    // 将 signal 绑定到 Axios 配置上
    mergedConfig.signal = config.signal || abortController.signal

    // 4. 发起请求并统一在 finally 中清理 Map
    try {
      const res = await this.axiosInstance.request<Res>(mergedConfig)
      return res.data as AppResponse<Res>
    } catch (error) {
      // 如果被取消的是 AxiosError，这里可以根据需要自定义处理
      this.options?.callbacks?.onError?.(error)
      throw error
    } finally {
      // 关键修复：无论成功还是失败，都必须清理资源防止内存泄漏
      this.abortMap.delete(requestId)
    }
  }
  private createRequestId(config: AxiosRequestConfig): string {
    const str = JSON.stringify({
      url: config.url,
      method: config.method,
      params: config.params,
      data: config.data,
    })
    return createMd5(str)
  }
}
