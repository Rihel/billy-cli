import { createAppClients } from '@repo/sdk'
import { Pages, PublicServerUrl, ServerUrl, TokenKey } from './constants'

/**
 * 应用侧 HTTP 客户端装配。
 *
 * 机制（浏览器单例 / 服务端无状态客户端 / 凭证读写 / 401 时清凭证）在 `@repo/sdk` 的
 * `createAppClients`；这里只注入本应用的取值与**应用独有**的 401 善后策略
 * —— 无需再手写一遍 ServerClient 的构造与凭证管理器（那是两个 app 曾经各抄一份的部分）。
 */
export const { getServerClient, useServerClient, createServerClient, saveToken, removeToken } =
  createAppClients({
    tokenKey: TokenKey,
    publicBaseUrl: PublicServerUrl,
    serverBaseUrl: ServerUrl,
    onUnauthorized: () => {
      if (typeof window === 'undefined') return
      window.location.replace(Pages.login)
    },
  })
