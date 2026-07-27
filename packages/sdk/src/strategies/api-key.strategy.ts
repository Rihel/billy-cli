import type { AuthStrategy, AuthStrategyType, AuthContext } from '../core/interfaces.js'

/** API Key 注入位置 */
export type ApiKeyLocation = 'header' | 'query'

/** API Key 凭证类型 */
export type ApiKeyCredentials = {
  /** API Key 值 */
  apiKey: string
  /** 请求头名称或查询参数名。默认 'X-API-Key' */
  keyName?: string
  /** 注入位置。默认 'header'（请求头） */
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
