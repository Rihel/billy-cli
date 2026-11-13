import type { AuthStrategy, CredentialProvider, CredentialsManager } from './interfaces.js'
import { ApiError, ApiErrorCodes } from './api-error.js'

/**
 * 凭证解析器 —— 负责完整的 credential 生命周期。
 *
 * 职责：
 *   - 从 CredentialsManager 获取凭证
 *   - 通过 AuthStrategy 校验凭证有效性
 *   - 通过 CredentialProvider 判断是否需要刷新
 *   - 必要时 acquire / refresh 新凭证并写回
 *   - 处理 acquire / refresh 并发去重
 *
 * 不负责：
 *   - HTTP 请求
 *   - header 注入
 *   - auth context 生成
 */
export class CredentialResolver<Credentials = Record<string, any>> {
  private acquirePromise: Promise<Credentials> | null = null
  private refreshPromise: Promise<Credentials> | null = null

  constructor(
    private readonly manager: CredentialsManager<Credentials>,
    private readonly authStrategy: AuthStrategy<Credentials>,
    private readonly provider?: CredentialProvider<Credentials>,
  ) {}

  /** 是否有 refresh 能力 */
  get canRefresh(): boolean {
    return !!this.provider?.refresh
  }

  /**
   * 获取一份经过校验的有效 credential。
   *
   * 流程：
   *   1. 从管理器中读取已有凭证
   *   2. provider 判断 needsRefresh → 是则 refresh 或 acquire → 写回
   *   3. AuthStrategy 校验凭证有效性，无效则抛错
   *   4. 返回有效凭证
   */
  async resolve(): Promise<Credentials> {
    let credentials = await this.manager.getCredentials()

    if (this.provider?.needsRefresh?.(credentials)) {
      credentials = this.provider.refresh
        ? await this.deduplicatedRefresh(credentials)
        : await this.deduplicatedAcquire()
      await this.manager.setCredentials(credentials)
    }

    const isValid = await this.authStrategy.isAuthorization(credentials)
    if (!isValid) {
      throw new ApiError(ApiErrorCodes.Unauthorized, '鉴权失败：凭证无效或未提供凭证。')
    }

    return credentials
  }

  /**
   * 强制刷新凭证（如 401 重试场景）。
   * 从管理器读取当前凭证，调用 refresh 后写回。
   * 需要 provider.refresh 已实现。
   */
  async forceRefresh(): Promise<Credentials> {
    if (!this.provider?.refresh) {
      throw new ApiError(ApiErrorCodes.NoRefreshAvailable, '未配置 refresh，无法强制刷新。')
    }
    const credentials = await this.manager.getCredentials()
    const fresh = await this.deduplicatedRefresh(credentials)
    await this.manager.setCredentials(fresh)
    return fresh
  }

  private async deduplicatedAcquire(): Promise<Credentials> {
    // 用显式 null 比较：packages 关闭 strictNullChecks 后真值判断会被误判成 Promise 条件
    if (this.acquirePromise === null) {
      this.acquirePromise = this.provider!.acquire().finally(() => {
        this.acquirePromise = null
      })
    }
    return this.acquirePromise
  }

  private async deduplicatedRefresh(credentials: Credentials): Promise<Credentials> {
    // 用显式 null 比较：packages 关闭 strictNullChecks 后真值判断会被误判成 Promise 条件
    if (this.refreshPromise === null) {
      this.refreshPromise = this.provider!.refresh!(credentials).finally(() => {
        this.refreshPromise = null
      })
    }
    return this.refreshPromise
  }
}
