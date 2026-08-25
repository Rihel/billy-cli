/** 支持的认证策略类型 */
export type AuthStrategyType = 'apiKey' | 'oauth2' | 'bearerToken' | 'hmac'

/**
 * HTTP 请求配置。
 * 与具体传输实现解耦：内部通过 fetch 执行。
 * 字段命名沿用 axios 习惯（params / data），便于迁移。
 */
export interface HttpRequestConfig<Body = any> {
  /** 请求路径（相对 baseUrl）或完整 URL */
  url: string
  /** HTTP 方法，默认 GET */
  method?: string
  /** 请求头 */
  headers?: Record<string, string | undefined>
  /** 查询参数（拼接到 url 上） */
  params?: Record<string, any>
  /** 请求体 */
  data?: Body
  /** 取消信号（如 cancelPrevious 生成的 AbortSignal） */
  signal?: AbortSignal
  /** 超时毫秒数，<= 0 表示不超时 */
  timeout?: number
}

/**
 * 认证上下文。
 * 由 AuthStrategy 生成，注入到请求的不同位置。
 */
export type AuthContext = {
  baseURL?: string
  url?: string
  /** 注入到请求头 */
  headers?: Record<string, string>
  /** 注入到请求体 */
  body?: Record<string, any>
  /** 注入到查询参数 */
  query?: Record<string, any>
}

/**
 * 凭证管理器接口。
 * 负责凭证的存取，不关心凭证的内容和用途。
 */
export interface CredentialsManager<Credentials = Record<string, any>> {
  /** 读取当前凭证。无凭证时返回空对象。 */
  getCredentials: () => Promise<Credentials>
  /** 写入凭证。 */
  setCredentials: (credentials: Credentials) => Promise<void>
  /** 清除凭证。 */
  clearCredentials: () => Promise<void>
}

/**
 * 认证策略接口。
 * 负责校验凭证有效性，并将凭证转换为请求上下文（headers / body / query）。
 */
export interface AuthStrategy<Credentials = Record<string, any>> {
  /** 策略类型标识 */
  type: AuthStrategyType
  /** 将凭证转换为请求注入上下文 */
  getAuthContext(
    credentials: Credentials,
    context: AuthContext,
  ): Promise<AuthContext>
  /** 判断凭证是否有效 */
  isAuthorization(credentials?: Credentials): Promise<boolean>
}

/**
 * 凭证供应器接口。
 * 负责凭证的获取与续期，不关心凭证存哪里、怎么用。
 * 与 CredentialsManager 配合使用：
 *   - CredentialsManager 管读写
 *   - CredentialProvider 管获取/刷新
 */
export interface CredentialProvider<Credentials = Record<string, any>> {
  /**
   * 获取一份新凭证。
   * 凭证不存在或 needsRefresh 返回 true 时调用。必须实现。
   */
  acquire(): Promise<Credentials>

  /**
   * 续期凭证。
   * 凭证需要刷新时调用。不实现时走 acquire 重新获取。
   */
  refresh?(credentials: Credentials): Promise<Credentials>

  /**
   * 判断凭证是否需要刷新。
   * 返回 true 时触发 refresh 或 acquire。
   * 为空、过期、即将过期都返回 true。不实现则一直返回 false。
   */
  needsRefresh?(credentials: Credentials): boolean
}
