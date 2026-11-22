/**
 * Redis 连接串的可安全落日志部分。
 *
 * 完整 URL 可能带用户名 / 密码（`redis://user:pass@host:6379/0`），**任何情况下都不能原样进日志**。
 * 这里只解析出 host / port / TLS，解析失败也不回退到原文 —— 宁可记 `unknown`。
 */
export interface RedisTarget {
  host: string
  port: number
  tls: boolean
}

/** 解析 Redis URL；无法解析（无 scheme / 非法端口）时返回 null，绝不返回原始连接串 */
export const redisTargetOf = (url: string): RedisTarget | null => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!parsed.hostname) return null
  const tls = parsed.protocol === 'rediss:'
  const port = parsed.port ? Number(parsed.port) : tls ? 6380 : 6379
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null
  return { host: parsed.hostname, port, tls }
}
