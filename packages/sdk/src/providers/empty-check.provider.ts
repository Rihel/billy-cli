import type { CredentialProvider } from '../core/interfaces.js'

/**
 * 空凭证检测供应器。
 *
 * 凭证为空时触发 acquire，适合 email+password 自动登录等简单场景。
 * 不处理过期刷新，token 过期后重新 acquire。
 *
 * @example
 * ```ts
 * const client = new ServerClient({
 *   credentialsManager: new MemoryCredentialsManager(),
 *   authStrategy: new BearerTokenStrategy(),
 *   credentialProvider: new EmptyCheckProvider(
 *     () => client.auth.login({
 *       email: process.env.SERVICE_EMAIL!,
 *       password: process.env.SERVICE_PASSWORD!,
 *     }),
 *   ),
 * })
 * ```
 */
export class EmptyCheckProvider<C extends Record<string, any>>
  implements CredentialProvider<C>
{
  constructor(private fn: () => Promise<C>) {}

  acquire(): Promise<C> {
    return this.fn()
  }

  needsRefresh(credentials: C): boolean {
    return Object.values(credentials).every((v) => !v)
  }
}
