import type { CredentialsManager } from '../core/interfaces.js'

/** 存储凭证管理器配置选项 */
export type StorageCredentialsManagerOptions = {
  /** 存储键名前缀。用于避免不同应用间的键名冲突。 */
  prefix?: string
  /** 调试日志记录器。 */
  logger?: Pick<Console, 'warn' | 'error'>
}

/**
 * 基于 localStorage 的凭证管理器。
 *
 * 凭证序列化为 JSON 存到浏览器 `localStorage`，仅浏览器环境可用。
 *
 * @example
 * ```ts
 * const manager = new LocalStorageCredentialsManager<BearerTokenCredentials>(
 *   'billy-token',
 *   { prefix: 'myapp' },
 * )
 *
 * // 登录后写入
 * await manager.setCredentials({ token: 'xxx' })
 *
 * // 后续请求自动读取
 * const creds = await manager.getCredentials()
 *
 * // 退出登录
 * await manager.clearCredentials()
 * ```
 */
export class LocalStorageCredentialsManager<
  Credentials extends Record<string, any>,
> implements CredentialsManager<Credentials> {
  private readonly storageKey: string
  private logger?: Pick<Console, 'warn' | 'error'>

  constructor(storageKey: string, options?: StorageCredentialsManagerOptions) {
    this.storageKey = options?.prefix
      ? `${options.prefix}:${storageKey}`
      : storageKey
    this.logger = options?.logger
  }

  async getCredentials(): Promise<Credentials> {
    if (typeof localStorage === 'undefined') {
      this.logger?.warn(
        `[LocalStorageCredentialsManager] localStorage 不可用，键名="${this.storageKey}"`,
      )
      return {} as Credentials
    }

    try {
      const raw = localStorage.getItem(this.storageKey)
      if (!raw) return {} as Credentials
      return JSON.parse(raw) as Credentials
    } catch (error) {
      this.logger?.error(
        `[LocalStorageCredentialsManager] 解析凭证失败，键名="${this.storageKey}"`,
        error,
      )
      return {} as Credentials
    }
  }

  async setCredentials(credentials: Credentials): Promise<void> {
    if (typeof localStorage === 'undefined') {
      this.logger?.warn(
        `[LocalStorageCredentialsManager] localStorage 不可用，键名="${this.storageKey}"`,
      )
      return
    }

    try {
      localStorage.setItem(this.storageKey, JSON.stringify(credentials))
    } catch (error) {
      this.logger?.error(
        `[LocalStorageCredentialsManager] 写入凭证失败，键名="${this.storageKey}"`,
        error,
      )
      throw error
    }
  }

  async clearCredentials(): Promise<void> {
    if (typeof localStorage === 'undefined') {
      return
    }

    try {
      localStorage.removeItem(this.storageKey)
    } catch (error) {
      this.logger?.error(
        `[LocalStorageCredentialsManager] 清除凭证失败，键名="${this.storageKey}"`,
        error,
      )
      throw error
    }
  }
}
