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
}

export const serverConfig: ServerConfig = {
  port: Number(process.env.PORT ?? 9989),
  resetPasswordTokenTtlMinutes: Number(
    process.env.RESET_PASSWORD_TOKEN_TTL_MINUTES ?? 30,
  ),
}
