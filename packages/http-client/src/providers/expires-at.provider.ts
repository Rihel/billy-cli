import type { CredentialProvider } from '../core/interfaces.js'

/**
 * 过期时间检测供应器。
 *
 * 凭证中包含 `expiresAt` 字段（毫秒时间戳）时，
 * 触发 refresh 续期，无 refresh 时走 acquire 重新获取。
 *
 * @example
 * ```ts
 * const client = new ServerClient({
 *   credentialsManager: new LocalStorageCredentialsManager('token'),
 *   authStrategy: new BearerTokenStrategy(),
 *   credentialProvider: new ExpiresAtProvider({
 *     acquire: () => client.auth.login({ email, password }),
 *     refresh: (c) => client.auth.refresh({ refreshToken: c.refreshToken }),
 *   }),
 * })
 * ```
 */
export class ExpiresAtProvider<C extends { expiresAt?: number }> implements CredentialProvider<C> {
  constructor(
    private options: {
      acquire: () => Promise<C>
      refresh?: (credentials: C) => Promise<C>
    },
  ) {}

  acquire(): Promise<C> {
    return this.options.acquire()
  }

  refresh(credentials: C): Promise<C> {
    if (!this.options.refresh) {
      return this.options.acquire()
    }
    return this.options.refresh(credentials)
  }

  needsRefresh(credentials: C): boolean {
    if (!credentials.expiresAt) return true
    // 过期前 1 分钟触发刷新
    return Date.now() + 60_000 >= credentials.expiresAt
  }
}
