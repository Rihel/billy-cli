import type {
  AuthStrategy,
  AuthStrategyType,
  AuthContext,
  CredentialsManager,
} from '../core/interfaces.js'

/** OAuth2 凭证类型 */
export type OAuth2Credentials = {
  /** 访问令牌 */
  accessToken: string
  /** 刷新令牌（可选，用于自动续期） */
  refreshToken?: string
  /** Token 过期时间戳（毫秒）。传入后启用自动过期检测。 */
  expiresAt?: number
}

/** OAuth2 策略配置选项 */
export type OAuth2StrategyOptions = {
  /**
   * 访问令牌过期时调用，应返回新的凭证。
   * 不传则不支持自动刷新。
   */
  onRefresh?: (
    credentials: OAuth2Credentials,
    manager: CredentialsManager<OAuth2Credentials>,
  ) => Promise<OAuth2Credentials>
  /** 过期前多久触发刷新（毫秒）。默认 60000（1 分钟） */
  refreshMarginMs?: number
}

/**
 * OAuth2 Bearer Token 认证策略。
 *
 * 支持自动刷新令牌：检测到即将过期时触发 `onRefresh` 回调，
 * 刷新后自动回写 `CredentialsManager`。
 *
 * @example
 * ```ts
 * const client = new HttpClient({
 *   authStrategy: new OAuth2Strategy({
 *     onRefresh: async (creds, manager) => {
 *       const res = await fetch('/auth/refresh', {
 *         method: 'POST',
 *         body: JSON.stringify({ refreshToken: creds.refreshToken }),
 *       })
 *       const next = await res.json()
 *       await manager.setCredentials(next)
 *       return next
 *     },
 *   }),
 *   credentialsManager: myManager,
 * })
 * ```
 */
export class OAuth2Strategy implements AuthStrategy<OAuth2Credentials> {
  readonly type: AuthStrategyType = 'oauth2'

  constructor(private options?: OAuth2StrategyOptions) {}

  async isAuthorization(credentials: OAuth2Credentials): Promise<boolean> {
    return !!credentials?.accessToken
  }

  async getAuthContext(credentials: OAuth2Credentials): Promise<AuthContext> {
    // 如果即将过期且有 refresh 能力，抛错误通知上层刷新
    if (this.shouldRefresh(credentials)) {
      throw new OAuth2NeedsRefreshError(credentials)
    }

    return {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
      },
    }
  }

  /**
   * 刷新访问令牌。
   * 在 HttpClient 的 onUnauthorized 回调中调用，
   * 或捕获 OAuth2NeedsRefreshError 后手动调用。
   */
  async refresh(
    credentials: OAuth2Credentials,
    manager: CredentialsManager<OAuth2Credentials>,
  ): Promise<OAuth2Credentials> {
    if (!this.options?.onRefresh) {
      throw new Error('OAuth2Strategy：需要配置 onRefresh 回调才能刷新令牌。')
    }
    const next = await this.options.onRefresh(credentials, manager)
    return next
  }

  /** 判断是否需要刷新 */
  private shouldRefresh(credentials: OAuth2Credentials): boolean {
    if (!credentials.expiresAt || !this.options?.onRefresh) return false
    const margin = this.options.refreshMarginMs ?? 60_000
    return Date.now() + margin >= credentials.expiresAt
  }
}

/**
 * 令牌需要刷新时抛出的错误。
 *
 * 在请求管线中捕获此错误（如 fetch 封装或 HttpClient 回调），
 * 调用 `strategy.refresh()` 刷新后重试原请求。
 */
export class OAuth2NeedsRefreshError extends Error {
  readonly credentials: OAuth2Credentials

  constructor(credentials: OAuth2Credentials) {
    super('OAuth2 令牌需要刷新')
    this.name = 'OAuth2NeedsRefreshError'
    this.credentials = credentials
  }
}
