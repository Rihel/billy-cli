import type {
  AuthContext,
  AuthStrategy,
  HttpRequestConfig,
} from './interfaces.js'

/**
 * 认证注入器 —— 负责将 credential 转换为请求认证信息。
 *
 * 职责：
 *   - 调用 AuthStrategy 生成认证上下文
 *   - 将认证信息（headers / query / body）注入请求配置
 *
 * 不负责：
 *   - credential 生命周期管理
 *   - HTTP 请求
 */
export class AuthInjector<Credentials = Record<string, any>> {
  constructor(private readonly authStrategy: AuthStrategy<Credentials>) {}

  /**
   * 将凭证的认证信息注入到请求配置中。
   * 返回新配置，不修改原对象。
   */
  async inject<Body = any>(
    config: HttpRequestConfig<Body>,
    credentials: Credentials,
  ): Promise<HttpRequestConfig<Body>> {
    const context: AuthContext = {
      headers: config.headers as Record<string, string>,
      query: config.params as Record<string, any>,
      body: config.data as Record<string, any>,
    }
    const ctx = await this.authStrategy.getAuthContext(credentials, context)

    return {
      ...config,
      headers: {
        ...config.headers,
        ...(ctx.headers || {}),
      },
      params: {
        ...config.params,
        ...(ctx.query || {}),
      },
      data: ctx.body
        ? ({ ...config.data, ...ctx.body } as Body)
        : config.data,
    }
  }
}
