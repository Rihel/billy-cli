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
}

/** 解析布尔环境变量：未设置或非 'false' 一律视为 true（默认开启，保持向后兼容）。 */
const parseAuthEnabled = (value: string | undefined): boolean =>
  value === undefined ? true : value !== 'false'

export const serverConfig: ServerConfig = {
  port: Number(process.env.PORT ?? 9989),
  resetPasswordTokenTtlMinutes: Number(
    process.env.RESET_PASSWORD_TOKEN_TTL_MINUTES ?? 30,
  ),
  authEnabled: parseAuthEnabled(process.env.AUTH_ENABLED),
}
