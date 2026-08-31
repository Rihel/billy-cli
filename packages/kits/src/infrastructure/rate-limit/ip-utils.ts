import ipaddr from 'ipaddr.js'

/**
 * IP 白名单匹配工具（限流豁免 / 访问控制共用），基于 ipaddr.js。
 *
 * 支持：
 * - 精确匹配：IPv4 / IPv6；
 * - CIDR 网段：IPv4 / IPv6（如 `10.0.0.0/8`、`192.168.1.0/24`、`::1/128`）。
 *
 * 白名单条目可含空白（自动 trim），空条目忽略；非法 IP / 非法 CIDR 一律不匹配。
 */

/**
 * 规范化 IP 字符串：IPv6-mapped IPv4（`::ffff:1.2.3.4`）→ `1.2.3.4`，
 * 其余规范化到 ipaddr.js 的标准形式。Node 在 IPv6 双栈监听下，IPv4 连接的
 * socket 地址常为 `::ffff:<v4>`，不规范化会导致 IPv4 白名单 / CIDR 匹配失效。
 */
export const normalizeIp = (ip: string): string => {
  try {
    return ipaddr.process(ip).toString()
  } catch {
    return ip
  }
}

/**
 * 判断 IP 是否命中白名单。
 * @param ip 客户端 IP（'unknown' 或空串直接返回 false）
 * @param whitelist 白名单条目：精确 IP 或 CIDR 网段
 */
export const isIpWhitelisted = (ip: string, whitelist: string[]): boolean => {
  if (!ip || ip === 'unknown') return false
  let addr: ipaddr.IPv4 | ipaddr.IPv6
  try {
    addr = ipaddr.parse(ip)
    // IPv6-mapped IPv4（如 ::ffff:1.2.3.4）按 IPv4 参与匹配
    if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
      addr = addr.toIPv4Address()
    }
  } catch {
    return false
  }
  return whitelist.some((entry) => {
    const trimmed = entry.trim()
    if (!trimmed) return false
    if (trimmed.includes('/')) {
      try {
        const [rangeAddr, prefix] = ipaddr.parseCIDR(trimmed)
        if (addr.kind() !== rangeAddr.kind()) return false
        return addr.kind() === 'ipv4'
          ? (addr as ipaddr.IPv4).match([rangeAddr as ipaddr.IPv4, prefix])
          : (addr as ipaddr.IPv6).match([rangeAddr as ipaddr.IPv6, prefix])
      } catch {
        return false
      }
    }
    return addr.toString() === trimmed
  })
}
