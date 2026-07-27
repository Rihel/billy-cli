import type { AuthStrategy, AuthStrategyType, AuthContext } from '../interfaces.js'

export type ApiKeyLocation = 'header' | 'query'

export type ApiKeyCredentials = {
  apiKey: string
  /** Header name or query param name. Default: 'X-API-Key' */
  keyName?: string
  /** Where to place the key. Default: 'header' */
  location?: ApiKeyLocation
}

/**
 * API Key 认证策略。
 *
 * 支持两种注入方式：
 * - header（默认）：`X-API-Key: <key>`
 * - query：`?api_key=<key>`
 *
 * @example
 * ```ts
 * const client = new ApiClient({
 *   authStrategy: new ApiKeyStrategy(),
 *   credentialsManager: myManager,
 * })
 * ```
 */
export class ApiKeyStrategy implements AuthStrategy<ApiKeyCredentials> {
  readonly type: AuthStrategyType = 'apiKey'

  async isAuthorization(credentials: ApiKeyCredentials): Promise<boolean> {
    return !!credentials?.apiKey
  }

  async getAuthContext(
    credentials: ApiKeyCredentials,
  ): Promise<AuthContext> {
    const keyName = credentials.keyName ?? 'X-API-Key'
    const location = credentials.location ?? 'header'

    if (location === 'query') {
      return { query: { [keyName]: credentials.apiKey } }
    }

    return { headers: { [keyName]: credentials.apiKey } }
  }
}
