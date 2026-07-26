import type { CredentialsManager } from '../interfaces.js'

export type CookieGetter = () => string | undefined | null | Promise<string | undefined | null>
export type CookieSetter = (value: string) => void | Promise<void>
export type CookieClearer = () => void | Promise<void>

export type CookieCredentialsManagerOptions = {
  /**
   * Custom cookie read function.
   * Default: reads `document.cookie` and parses it.
   * For Next.js SSR, pass `() => cookies().get('my-token')?.value`.
   */
  getter?: CookieGetter
  /**
   * Custom cookie write function.
   * Default: writes via `document.cookie`.
   * For Next.js SSR, pass `(value) => cookies().set('my-token', value)`.
   */
  setter?: CookieSetter
  /**
   * Custom cookie delete function.
   * Default: clears cookie via `document.cookie` with max-age=0.
   * For Next.js SSR, pass `() => cookies().delete('my-token')`.
   */
  clearer?: CookieClearer
  /** Logger for debugging. */
  logger?: Pick<Console, 'warn' | 'error'>
}

/**
 * 基于 Cookie 的凭证管理器。
 *
 * 浏览器环境默认使用 `document.cookie` 读写。
 * SSR（Next.js Server Actions / Server Components）环境通过传入自定义
 * `getter`/`setter`/`clearer` 来对接 `cookies()` API。
 *
 * @example
 * ```ts
 * // 浏览器环境 — 自动使用 document.cookie
 * const browserManager = new CookieCredentialsManager('access-token')
 *
 * // Next.js SSR — 对接 cookies() API
 * import { cookies } from 'next/headers'
 *
 * const ssrManager = new CookieCredentialsManager('access-token', {
 *   getter: async () => (await cookies()).get('access-token')?.value,
 *   setter: async (value) => (await cookies()).set('access-token', value, { httpOnly: true }),
 *   clearer: async () => (await cookies()).delete('access-token'),
 * })
 * ```
 */
export class CookieCredentialsManager implements CredentialsManager<{ token: string }> {
  private readonly cookieName: string
  private readonly cookieOptions: string
  private getter: CookieGetter
  private setter: CookieSetter
  private clearer: CookieClearer
  private logger?: Pick<Console, 'warn' | 'error'>

  constructor(
    cookieName: string,
    options?: CookieCredentialsManagerOptions,
  ) {
    this.cookieName = cookieName
    this.logger = options?.logger
    this.getter = options?.getter ?? this.defaultGetter.bind(this)
    this.setter = options?.setter ?? this.defaultSetter.bind(this)
    this.clearer = options?.clearer ?? this.defaultClearer.bind(this)

    this.cookieOptions = [
      'path=/',
      'max-age=' + 7 * 24 * 60 * 60, // 7 days
      ...(typeof window !== 'undefined' && window.location.protocol === 'https:'
        ? ['Secure']
        : []),
    ].join('; ')
  }

  async getCredentials(): Promise<{ token: string }> {
    try {
      const raw = await this.getter()
      if (!raw) return { token: '' }
      return { token: raw }
    } catch (error) {
      this.logger?.warn(
        `[CookieCredentialsManager] Failed to read cookie "${this.cookieName}"`,
        error,
      )
      return { token: '' }
    }
  }

  async setCredentials(credentials: { token: string }): Promise<void> {
    try {
      await this.setter(credentials.token)
    } catch (error) {
      this.logger?.error(
        `[CookieCredentialsManager] Failed to write cookie "${this.cookieName}"`,
        error,
      )
      throw error
    }
  }

  async clearCredentials(): Promise<void> {
    try {
      await this.clearer()
    } catch (error) {
      this.logger?.error(
        `[CookieCredentialsManager] Failed to clear cookie "${this.cookieName}"`,
        error,
      )
      throw error
    }
  }

  private defaultGetter(): string | null {
    if (typeof document === 'undefined') return null
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${this.cookieName}=([^;]*)`),
    )
    return match ? decodeURIComponent(match[1]) : null
  }

  private defaultSetter(value: string): void {
    if (typeof document === 'undefined') return
    document.cookie = `${this.cookieName}=${encodeURIComponent(value)}; ${this.cookieOptions}`
  }

  private defaultClearer(): void {
    if (typeof document === 'undefined') return
    document.cookie = `${this.cookieName}=; path=/; max-age=0`
  }
}
