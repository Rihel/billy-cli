import type { CredentialsManager } from '../core/interfaces.js'

/** Cookie 读取函数类型 */
export type CookieGetter = () =>
  | string
  | undefined
  | null
  | Promise<string | undefined | null>

/** Cookie 写入函数类型 */
export type CookieSetter = (value: string) => void | Promise<void>

/** Cookie 清除函数类型 */
export type CookieClearer = () => void | Promise<void>

/** Cookie 凭证管理器配置选项 */
export type CookieCredentialsManagerOptions = {
  /**
   * 自定义 Cookie 读取函数。
   * 默认：解析 `document.cookie`。
   * Next.js SSR 场景：`() => cookies().get('my-token')?.value`
   */
  getter?: CookieGetter
  /**
   * 自定义 Cookie 写入函数。
   * 默认：写入 `document.cookie`。
   * Next.js SSR 场景：`(value) => cookies().set('my-token', value)`
   */
  setter?: CookieSetter
  /**
   * 自定义 Cookie 清除函数。
   * 默认：将 Cookie 的 max-age 设为 0。
   * Next.js SSR 场景：`() => cookies().delete('my-token')`
   */
  clearer?: CookieClearer
  /** 调试日志记录器。 */
  logger?: Pick<Console, 'warn' | 'error'>
}

/**
 * 基于 Cookie 的凭证管理器。
 *
 * 浏览器环境默认使用 `document.cookie` 读写。
 * SSR（Next.js Server Actions / Server Components）环境通过传入自定义
 * `getter` / `setter` / `clearer` 来对接 `cookies()` API。
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
export class CookieCredentialsManager implements CredentialsManager<{
  token: string
}> {
  private readonly cookieName: string
  private readonly cookieOptions: string
  private getter: CookieGetter
  private setter: CookieSetter
  private clearer: CookieClearer
  private logger?: Pick<Console, 'warn' | 'error'>

  constructor(cookieName: string, options?: CookieCredentialsManagerOptions) {
    this.cookieName = cookieName
    this.logger = options?.logger
    this.getter = options?.getter ?? this.defaultGetter.bind(this)
    this.setter = options?.setter ?? this.defaultSetter.bind(this)
    this.clearer = options?.clearer ?? this.defaultClearer.bind(this)

    this.cookieOptions = [
      'path=/',
      'max-age=' + 7 * 24 * 60 * 60, // 7 天过期
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
        `[CookieCredentialsManager] 读取 Cookie 失败，名称="${this.cookieName}"`,
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
        `[CookieCredentialsManager] 写入 Cookie 失败，名称="${this.cookieName}"`,
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
        `[CookieCredentialsManager] 清除 Cookie 失败，名称="${this.cookieName}"`,
        error,
      )
      throw error
    }
  }

  /** 默认 Cookie 读取：解析 document.cookie */
  private defaultGetter(): string | null {
    if (typeof document === 'undefined') return null
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\\\s*)${this.cookieName}=([^;]*)`),
    )
    return match ? decodeURIComponent(match[1]) : null
  }

  /** 默认 Cookie 写入：写入 document.cookie */
  private defaultSetter(value: string): void {
    if (typeof document === 'undefined') return
    document.cookie = `${this.cookieName}=${encodeURIComponent(value)}; ${this.cookieOptions}`
  }

  /** 默认 Cookie 清除：将 max-age 设为 0 */
  private defaultClearer(): void {
    if (typeof document === 'undefined') return
    document.cookie = `${this.cookieName}=; path=/; max-age=0`
  }
}
