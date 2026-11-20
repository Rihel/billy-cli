import {
  CredentialRefreshRejectedError,
  type CredentialRefreshAdapter,
} from './credential-refresh.js'

/** 飞书开放平台配置（来自平台应用：`LARK_APP_ID` / `LARK_APP_SECRET`） */
export interface LarkOAuthConfig {
  appId: string
  appSecret: string
  /** 开放平台地址（默认飞书国内站；私有化部署可覆盖） */
  baseUrl?: string
}

/** 确定性失效码：只有这些才把凭据置 expired，其余按可重试处理 */
const REJECTED_CODES = new Set(['invalid_grant', 'invalid_token', 'invalid_request'])

/**
 * 飞书 OAuth 刷新适配器（`docs/design/workspace-cli-credentials.md` §6.4.6 / P11）。
 *
 * - 用**平台应用**的 `app_id` / `app_secret` 换新 token（用户的 refresh token 由平台托管）；
 * - 上游明确拒绝（`invalid_grant` / `invalid_token`）→ 抛 `CredentialRefreshRejectedError`，
 *   由解析服务置 `expired` 并提示重新授权；
 * - 超时 / 5xx / 网络错误 → 原样抛出，由解析服务按"可重试、不降级"处理。
 */
export const createLarkRefreshAdapter = (config: LarkOAuthConfig): CredentialRefreshAdapter => ({
  provider: 'lark',
  async refresh({ secret }) {
    const refreshToken = secret.refreshToken
    if (typeof refreshToken !== 'string' || refreshToken.trim() === '') {
      throw new CredentialRefreshRejectedError('lark', 'missing_refresh_token')
    }

    const response = await fetch(
      `${(config.baseUrl ?? 'https://open.feishu.cn').replace(/\/+$/, '')}/open-apis/authen/v2/oauth/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: config.appId,
          client_secret: config.appSecret,
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    )

    const body = (await response.json().catch(() => ({}))) as {
      code?: number
      error?: string
      error_description?: string
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }

    // 飞书 oauth/token 失败时通常是 HTTP 200 + 非 0 code（也可能 4xx）
    const failureCode = body.error ?? (body.code && body.code !== 0 ? String(body.code) : undefined)
    if (!response.ok || failureCode) {
      if (response.status === 400 || response.status === 401 || failureCode) {
        if (REJECTED_CODES.has(failureCode ?? '') || response.status === 401) {
          throw new CredentialRefreshRejectedError('lark', failureCode ?? 'unauthorized')
        }
      }
      throw new Error(
        `飞书刷新失败：HTTP ${response.status}${failureCode ? ` (${failureCode})` : ''}`,
      )
    }
    if (!body.access_token) throw new Error('飞书刷新响应缺少 access_token')

    const expiresIn = body.expires_in && body.expires_in > 0 ? body.expires_in : 7200
    return {
      secret: {
        ...secret,
        accessToken: body.access_token,
        // 飞书会轮换 refresh token；没给就保留旧的（下次仍可用）
        refreshToken: body.refresh_token ?? refreshToken,
      },
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    }
  },
})
