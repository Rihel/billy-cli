import type { CredentialsManager } from '../interfaces.js'

/**
 * 基于内存的凭证管理器。
 * 凭证保存在 JS 变量中，页面刷新/进程重启即丢失。
 * 适合测试环境、CLI 工具，或不需要持久化的场景。
 *
 * @example
 * ```ts
 * // 测试场景
 * const manager = new MemoryCredentialsManager({ token: 'test-token' })
 *
 * // 运行时动态设置
 * await manager.setCredentials({ token: 'xxx' })
 * ```
 */
export class MemoryCredentialsManager<Credentials extends Record<string, any>>
  implements CredentialsManager<Credentials>
{
  private data: Credentials

  constructor(initial?: Credentials) {
    this.data = initial ?? ({} as Credentials)
  }

  async getCredentials(): Promise<Credentials> {
    return this.data
  }

  async setCredentials(credentials: Credentials): Promise<void> {
    this.data = credentials
  }

  async clearCredentials(): Promise<void> {
    this.data = {} as Credentials
  }
}
