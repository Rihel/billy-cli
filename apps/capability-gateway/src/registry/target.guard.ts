import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * 外部服务目标校验（协议 §4.4）：默认 https、显式允许才放行 http、禁止内网 / 回环 / 元数据地址。
 *
 * 为什么每次调用都要校验（而不是登记时一次）：DNS rebinding —— 登记时解析到公网 IP、
 * 调用时换成内网 IP。这里在**登记、探活、调用**三个出口都跑一遍。
 *
 * 部署开关：`gateway.allowPrivateNetwork`（生产必须 false；本地 / 测试默认放行内网）。
 */
export class UnsafeTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeTargetError'
  }
}

const isPrivateV4 = (ip: string): boolean =>
  ip.startsWith('0.') ||
  ip.startsWith('10.') ||
  ip.startsWith('127.') ||
  ip.startsWith('169.254.') ||
  ip.startsWith('192.168.') ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)

const isPrivateV6 = (ip: string): boolean => {
  const lower = ip.toLowerCase()
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    /^fe[89ab]/.test(lower) ||
    // ::ffff:127.0.0.1 这类 v4 映射地址
    (lower.startsWith('::ffff:') && isPrivateV4(lower.slice('::ffff:'.length)))
  )
}

export interface TargetGuardOptions {
  /** 登记时是否显式勾选「允许 http」（默认 https） */
  allowHttp?: boolean
  /** 是否允许内网 / 回环目标（生产必须 false） */
  allowPrivateNetwork?: boolean
}

/** 校验一个外部服务地址；不合法抛 `UnsafeTargetError`，合法返回解析后的 URL */
export const assertSafeTarget = async (
  raw: string,
  options: TargetGuardOptions = {},
): Promise<URL> => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeTargetError(`地址不是合法 URL：${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeTargetError(`只支持 http / https，收到 ${url.protocol}`)
  }
  if (url.protocol === 'http:' && options.allowHttp !== true) {
    throw new UnsafeTargetError('http 地址需要在登记时显式勾选「允许 http」')
  }
  if (options.allowPrivateNetwork === true) return url

  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new UnsafeTargetError('不允许指向 localhost')
  }
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((item) => item.address)
  for (const address of addresses) {
    const privateAddress = isIP(address) === 6 ? isPrivateV6(address) : isPrivateV4(address)
    if (privateAddress) {
      throw new UnsafeTargetError(`目标地址不允许（${address} 属于内网 / 回环 / 保留地址）`)
    }
  }
  return url
}

/** 读配置里的部署开关：未配置时按环境兜底（生产默认禁止内网，开发 / 测试放行） */
export const allowPrivateNetworkOf = (configured: boolean | undefined): boolean =>
  configured ?? process.env.NODE_ENV !== 'production'
