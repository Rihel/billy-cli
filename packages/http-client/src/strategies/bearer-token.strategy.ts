import type { AuthStrategy, AuthStrategyType, AuthContext } from '../core/interfaces.js'

/** Bearer Token 凭证类型 */
export type BearerTokenCredentials = {
  /** JWT 或任意格式的 bearer token */
  token: string
}

/**
 * Bearer Token 认证策略。
 *
 * 将凭证注入到请求头：`Authorization: Bearer <token>`
 *
 * @example
 * ```ts
 * const client = new HttpClient({
 *   authStrategy: new BearerTokenStrategy(),
 *   credentialsManager: myManager,
 * })
 * ```
 */
export class BearerTokenStrategy implements AuthStrategy<BearerTokenCredentials> {
  type: AuthStrategyType = 'bearerToken'

  async isAuthorization(credentials: BearerTokenCredentials): Promise<boolean> {
    return !!credentials?.token
  }

  async getAuthContext(credentials: BearerTokenCredentials): Promise<AuthContext> {
    return {
      headers: {
        Authorization: `Bearer ${credentials.token}`,
      },
    }
  }
}
