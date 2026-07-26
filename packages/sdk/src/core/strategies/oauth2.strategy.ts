import type { AuthStrategy, AuthStrategyType, AuthContext, CredentialsManager } from '../interfaces.js'

export type OAuth2Credentials = {
  accessToken: string
  refreshToken?: string
  /** Token expiration timestamp (ms). Optional, enables auto-refresh. */
  expiresAt?: number
}

export type OAuth2StrategyOptions = {
  /** Called when access token needs refresh. Should return new credentials. */
  onRefresh?: (
    credentials: OAuth2Credentials,
    manager: CredentialsManager<OAuth2Credentials>,
  ) => Promise<OAuth2Credentials>
  /** Minimum time before expiration to trigger refresh (ms). Default: 60000 (1min) */
  refreshMarginMs?: number
}

/**
 * OAuth2 Bearer Token 认证策略。
 *
 * 支持自动刷新 token：检测到即将过期时触发 `onRefresh` 回调，
 * 刷新后自动回写 `CredentialsManager`。
 *
 * @example
 * ```ts
 * const client = new ApiClient({
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

  async getAuthContext(
    credentials: OAuth2Credentials,
  ): Promise<AuthContext> {
    // 如果即将过期且有 refresh 能力，尝试自动刷新
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
   * Refresh the access token. Call this from your ApiClient's onUnauthorized
   * or manually when catching OAuth2NeedsRefreshError.
   */
  async refresh(
    credentials: OAuth2Credentials,
    manager: CredentialsManager<OAuth2Credentials>,
  ): Promise<OAuth2Credentials> {
    if (!this.options?.onRefresh) {
      throw new Error(
        'OAuth2Strategy: onRefresh callback is required for token refresh.',
      )
    }
    const next = await this.options.onRefresh(credentials, manager)
    return next
  }

  private shouldRefresh(credentials: OAuth2Credentials): boolean {
    if (!credentials.expiresAt || !this.options?.onRefresh) return false
    const margin = this.options.refreshMarginMs ?? 60_000
    return Date.now() + margin >= credentials.expiresAt
  }
}

/**
 * Error thrown when token needs refresh. Catch it in your request pipeline
 * (e.g., axios interceptor or ApiClient callbacks), call `strategy.refresh()`,
 * then retry the original request.
 */
export class OAuth2NeedsRefreshError extends Error {
  readonly credentials: OAuth2Credentials

  constructor(credentials: OAuth2Credentials) {
    super('OAuth2 token needs refresh')
    this.name = 'OAuth2NeedsRefreshError'
    this.credentials = credentials
  }
}
