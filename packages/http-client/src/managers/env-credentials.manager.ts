import type { CredentialsManager } from '../core/interfaces.js'

/**
 * 基于环境变量的静态凭证管理器。
 *
 * 适用于服务间通信、后台任务、CLI 等无需动态刷新的场景。
 * 凭证在构造函数中一次确定，setCredentials / clearCredentials 均为空操作。
 *
 * @example
 * ```ts
 * // 从环境变量读取
 * const manager = new EnvCredentialsManager({
 *   accessKey: process.env.API_ACCESS_KEY!,
 *   secretKey: process.env.API_SECRET_KEY!,
 * })
 *
 * // 直接指定静态值
 * const manager = new EnvCredentialsManager({ token: 'static-token' })
 * ```
 */
export class EnvCredentialsManager<
  Credentials extends Record<string, any>,
> implements CredentialsManager<Credentials> {
  private data: Credentials

  constructor(credentials: Credentials) {
    this.data = { ...credentials }
  }

  async getCredentials(): Promise<Credentials> {
    return this.data
  }

  /** EnvCredentialsManager 不支持动态写入。 */
  async setCredentials(_credentials: Credentials): Promise<void> {
    // 空操作
  }

  /** EnvCredentialsManager 不支持清除。 */
  async clearCredentials(): Promise<void> {
    // 空操作
  }
}
