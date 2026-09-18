/**
 * 应用地址配置（web / admin / 脚手架生成的前端共用一份）。
 *
 * 分界：**机制在共享层，取值由应用注入** —— 本文件只管「怎么回落、怎么拼」，
 * `process.env` 的读取留在各 app：`NEXT_PUBLIC_*` 是 Next 在**构建期替换**的，
 * 一旦这段读取被搬进 `serverExternalPackages` 外置的包里就不再发生替换
 * （本地正常、容器里读到 undefined 并静默回落到 localhost）。
 */

/** 本仓本地开发默认地址（dev 走 server 9989 / minio 桶 billy-cli），仅作缺省回落 */
export const DEV_SERVER_URL = 'http://localhost:9989'
export const DEV_STORAGE_URL = 'http://localhost:9000/billy-cli'

export interface AppUrlConfigOptions {
  /** 浏览器端公开地址（app 传 `process.env.NEXT_PUBLIC_SERVER_URL`） */
  publicServerUrl?: string
  /** 服务端运行时地址（app 传 `process.env.SERVER_URL`），容器内可指向内网 */
  runtimeServerUrl?: string
  /** 对象存储公开地址（app 传 `process.env.NEXT_PUBLIC_STORAGE_URL`） */
  storageUrl?: string
  /** 服务端地址缺省回落（默认本仓本地开发约定） */
  fallbackServerUrl?: string
  /** 对象存储地址缺省回落（默认本仓本地开发约定） */
  fallbackStorageUrl?: string
}

export interface AppUrlConfig {
  /** 浏览器可达的 API 地址 */
  publicServerUrl: string
  /** 服务端（SSR / Server Actions）API 地址：优先运行时地址，回落公开地址 */
  serverUrl: string
  /** 对象存储基地址 */
  storageUrl: string
  /** 对象存储 key → 可直接放进 `src` 的完整 URL（空 key 返回空串） */
  formatStorageUrl: (key: string) => string
}

/**
 * 解析应用地址：公开地址 / 运行时服务端地址 / 对象存储基地址，以及 key → URL 的拼接。
 *
 * @example
 * ```ts
 * const urls = createAppUrlConfig({
 *   publicServerUrl: process.env.NEXT_PUBLIC_SERVER_URL,
 *   runtimeServerUrl: process.env.SERVER_URL,
 *   storageUrl: process.env.NEXT_PUBLIC_STORAGE_URL,
 * })
 * urls.formatStorageUrl('avatar/a.png') // http://localhost:9000/billy-cli/avatar/a.png
 * ```
 */
export function createAppUrlConfig(
  options: AppUrlConfigOptions = {},
): AppUrlConfig {
  const publicServerUrl =
    options.publicServerUrl || options.fallbackServerUrl || DEV_SERVER_URL
  const storageUrl =
    options.storageUrl || options.fallbackStorageUrl || DEV_STORAGE_URL

  return {
    publicServerUrl,
    serverUrl: options.runtimeServerUrl || publicServerUrl,
    storageUrl,
    formatStorageUrl: (key: string) => {
      if (!key) return ''
      if (key.startsWith('http://') || key.startsWith('https://')) {
        return key
      }
      return `${storageUrl}/${key}`
    },
  }
}
