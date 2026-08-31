/**
 * 应用层业务配置（不属于 kits 能力配置）：
 * 端口、认证业务策略等由本应用自行定义与解析（env / 文件 / 远程，来源自定）。
 */
export const ServerConfig = Symbol.for('ServerConfig')

export interface ServerConfig {
  /** HTTP 服务端口 */
  port: number
  /** 找回密码 token 有效期（分钟）——认证业务策略 */
  resetPasswordTokenTtlMinutes: number
  /**
   * 用户体系开关：false 时关闭前台用户 + 后台管理员两套鉴权，
   * 所有守卫直接放行，前端据此隐藏登录 / 用户管理相关 UI。
   * 适用于 clone 后自用、或用户体系由外部服务提供的场景。
   */
  authEnabled: boolean
  /**
   * 限流豁免白名单 IP（精确 IPv4 / IPv6 或 IPv4 CIDR，逗号分隔）。
   * 命中白名单的请求跳过限流（如内网 / 运维 / 监控探活）。
   */
  rateLimitWhitelist: string[]
  /**
   * 是否信任代理转发头（x-forwarded-for）：false（默认）时用直连 socket 地址，
   * 防止伪造 XFF 绕过限流；部署在可信反代 / LB 之后时置 true 取真实客户端 IP。
   */
  rateLimitTrustProxy: boolean
}

/** 解析布尔环境变量：未设置或非 'false' 一律视为 true（默认开启，保持向后兼容）。 */
const parseAuthEnabled = (value: string | undefined): boolean =>
  value === undefined ? true : value !== 'false'

/** 解析布尔环境变量（严格：'true' 才为 true）。 */
const parseBoolean = (value: string | undefined): boolean =>
  value === 'true'

/** 解析逗号分隔白名单（空串 → 空数组）。 */
const parseWhitelist = (value: string | undefined): string[] =>
  value ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : []

export const serverConfig: ServerConfig = {
  port: Number(process.env.PORT ?? 9989),
  resetPasswordTokenTtlMinutes: Number(
    process.env.RESET_PASSWORD_TOKEN_TTL_MINUTES ?? 30,
  ),
  authEnabled: parseAuthEnabled(process.env.AUTH_ENABLED),
  rateLimitWhitelist: parseWhitelist(process.env.RATE_LIMIT_WHITELIST),
  rateLimitTrustProxy: parseBoolean(process.env.RATE_LIMIT_TRUST_PROXY),
}
