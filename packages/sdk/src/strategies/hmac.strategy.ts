import type {
  AuthStrategy,
  AuthStrategyType,
  AuthContext,
} from '../core/interfaces.js'
import CryptoJs from 'crypto-js'

export type HmacCredentials = {
  accessKey: string
  secretKey: string
}

export type HmacAlgorithm = 'SHA-256' | 'SHA-384' | 'SHA-512'

export type HmacStrategyOptions = {
  /** Hash algorithm. Default: 'SHA-256' */
  algorithm?: HmacAlgorithm
  /** Header prefix for signature headers. Default: 'X-Hmac' */
  headerPrefix?: string
  /**
   * When true (default), signs the canonical request using timestamp + nonce only.
   * Set to false if you sign requests via an interceptor calling `strategy.sign()`.
   */
  autoSign?: boolean
  /**
   * Custom canonical request string builder (only used when autoSign is true).
   * Default: TIMESTAMP + '\n' + NONCE
   */
  buildCanonicalString?: (config: {
    timestamp: string
    nonce: string
    headers: Record<string, string>
  }) => string
}

/**
 * HMAC 签名认证策略。
 *
 * 使用对称密钥对请求进行签名，适用于 API 网关、第三方开放平台等场景。
 *
 * 签名流程（autoSign=true，默认）：
 * 1. 生成 timestamp + nonce
 * 2. 用 secretKey 对规范字符串 HMAC 签名
 * 3. 在 header 注入 X-Hmac-AccessKey / X-Hmac-Signature / X-Hmac-Timestamp / X-Hmac-Nonce
 *
 * 如需对 method + path + body 做全量签名（如阿里云、AWS 风格），
 * 在 axios 拦截器中调用 `strategy.sign(secretKey, canonicalString)` 自行处理。
 *
 * @example
 * ```ts
 * // 基本用法 — 自动签名 timestamp + nonce
 * const client = new ApiClient({
 *   authStrategy: new HmacStrategy(),
 *   credentialsManager: myManager,
 * })
 *
 * // 完整请求签名 — 通过 axios 拦截器
 * const strategy = new HmacStrategy({ autoSign: false })
 * axiosInstance.interceptors.request.use(async (config) => {
 *   const method = config.method?.toUpperCase() ?? 'GET'
 *   const path = config.url ?? '/'
 *   const body = config.data ? JSON.stringify(config.data) : ''
 *   const bodyHash = sha256Hex(body)
 *   const canonical = [method, path, bodyHash, Date.now()].join('\n')
 *   config.headers['X-Hmac-Signature'] = strategy.sign(secretKey, canonical)
 *   return config
 * })
 * ```
 */
export class HmacStrategy implements AuthStrategy<HmacCredentials> {
  readonly type: AuthStrategyType = 'hmac'
  private options: Required<HmacStrategyOptions>

  constructor(options?: HmacStrategyOptions) {
    this.options = {
      algorithm: options?.algorithm ?? 'SHA-256',
      headerPrefix: options?.headerPrefix ?? 'X-Hmac',
      autoSign: options?.autoSign ?? true,
      buildCanonicalString:
        options?.buildCanonicalString ??
        (({ timestamp, nonce }) => [timestamp, nonce].join('\n')),
    }
  }

  async isAuthorization(credentials: HmacCredentials): Promise<boolean> {
    return !!(credentials?.accessKey && credentials?.secretKey)
  }

  async getAuthContext(credentials: HmacCredentials): Promise<AuthContext> {
    const prefix = this.options.headerPrefix
    const timestamp = Date.now().toString()
    const nonce = this.generateNonce()

    const headers: Record<string, string> = {
      [`${prefix}-AccessKey`]: credentials.accessKey,
      [`${prefix}-Timestamp`]: timestamp,
      [`${prefix}-Nonce`]: nonce,
      [`${prefix}-Algorithm`]: this.options.algorithm,
    }

    if (this.options.autoSign) {
      const canonical = this.options.buildCanonicalString({
        timestamp,
        nonce,
        headers,
      })
      const signature = this.sign(credentials.secretKey, canonical)
      headers[`${prefix}-Signature`] = signature
    }

    return { headers }
  }

  /**
   * 用 secretKey 对任意字符串计算 HMAC 签名。
   * 可在 axios 拦截器中调用，实现 full-request signing。
   */
  sign(secretKey: string, data: string): string {
    const fn = this.hmacFn()
    return fn(data, secretKey).toString()
  }

  private generateNonce(): string {
    return CryptoJs.lib.WordArray.random(16).toString()
  }

  private hmacFn(): (data: string, key: string) => CryptoJs.lib.WordArray {
    switch (this.options.algorithm) {
      case 'SHA-384':
        return CryptoJs.HmacSHA384
      case 'SHA-512':
        return CryptoJs.HmacSHA512
      case 'SHA-256':
      default:
        return CryptoJs.HmacSHA256
    }
  }
}
