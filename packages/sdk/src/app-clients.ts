import {
  LocalStorageCredentialsManager,
  MemoryCredentialsManager,
} from '@repo/http-client'
import type {
  BearerTokenCredentials,
  CredentialsManager,
} from '@repo/http-client'
import { ServerClient } from './server.client.js'

/**
 * 应用侧 HTTP 客户端的装配（web / admin / 脚手架生成的前端共用）。
 *
 * 分界：**机制在这里，取值与善后策略由应用注入**。
 * 机制 = 浏览器端单例、服务端无状态客户端、凭证的读写与 401 时清理；
 * 应用私有 = 凭证键名、两端地址、401 之后干什么（跳哪个页面、是否撤销服务端会话）。
 *
 * 为什么归 sdk 而不是 `@repo/ui`：它包着 `ServerClient`，`@repo/ui` 是表现层，
 * 不允许依赖 sdk / http-client（见 docs/design/frontend-foundation.md 的分层）。
 */
export interface AppClientsOptions {
  /**
   * 浏览器 `localStorage` 的凭证键名。
   * 两端必须不同 —— 同域部署下共用一份存储，同名会互相覆盖登录态
   * （admin 用 `admin-access-token`，web 用 `access-token`）。
   */
  tokenKey: string
  /** 浏览器可达的后端地址（app 传 `process.env.NEXT_PUBLIC_SERVER_URL`） */
  publicBaseUrl: string
  /** 服务端（SSR / Server Actions）地址（app 传 `process.env.SERVER_URL`），容器内可指内网 */
  serverBaseUrl: string
  /**
   * 401 时应用自己的善后（如撤销服务端会话、跳登录页并带 `reason`）。
   * 浏览器端凭证的清理由本工厂负责，这里**只写应用独有**的部分。
   */
  onUnauthorized?: () => void | Promise<void>
}

export interface AppClients {
  /** 浏览器端单例（凭证存 `localStorage`），走浏览器可达的公开地址 */
  getServerClient(): ServerClient
  /** `getServerClient` 的别名，便于在组件里按 hook 习惯调用（其本身不使用 React） */
  useServerClient(): ServerClient
  /** 服务端（SSR / Server Actions）无状态客户端，走运行时地址 */
  createServerClient(token?: string): ServerClient
  /** 写入浏览器端凭证（登录 / 注册成功后与 httpOnly cookie 双写） */
  saveToken(token: string): Promise<void>
  /** 清理浏览器端凭证（登出或会话失效时调用） */
  removeToken(): Promise<void>
}

/**
 * 装配一个应用要用的 HTTP 客户端集合。
 *
 * @example
 * ```ts
 * export const { getServerClient, createServerClient, saveToken } = createAppClients({
 *   tokenKey: TokenKey,
 *   publicBaseUrl: PublicServerUrl,
 *   serverBaseUrl: ServerUrl,
 *   onUnauthorized: () => window.location.replace(Pages.login),
 * })
 * ```
 */
export function createAppClients(options: AppClientsOptions): AppClients {
  const tokenManager: CredentialsManager<BearerTokenCredentials> =
    new LocalStorageCredentialsManager<BearerTokenCredentials>(options.tokenKey)

  let clientInstance: ServerClient | null = null

  const getServerClient = (): ServerClient => {
    if (!clientInstance) {
      clientInstance = new ServerClient({
        baseUrl: options.publicBaseUrl,
        credentialsManager: tokenManager,
        callbacks: {
          onUnauthorized: async () => {
            // 只清浏览器端凭证：服务端无状态客户端不持有持久凭证（它传的 onUnauthorized 是空实现）
            if (typeof window !== 'undefined') {
              await tokenManager.clearCredentials()
            }
            await options.onUnauthorized?.()
          },
        },
      })
    }
    return clientInstance
  }

  return {
    getServerClient,
    useServerClient: getServerClient,

    createServerClient(token?: string) {
      const manager = new MemoryCredentialsManager<BearerTokenCredentials>()
      if (token) void manager.setCredentials({ token })

      return new ServerClient({
        baseUrl: options.serverBaseUrl,
        credentialsManager: manager,
        // 服务端无状态客户端没有「重新登录」这一说，401 交给调用方（SSR / Action）自行处理
        callbacks: { onUnauthorized: async () => {} },
      })
    },

    saveToken: (token: string) => tokenManager.setCredentials({ token }),
    removeToken: () => tokenManager.clearCredentials(),
  }
}
