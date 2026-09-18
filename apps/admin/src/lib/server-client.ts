import { createAppClients } from '@repo/sdk'
import { logoutAction } from '@/actions/auth.actions'
import { Pages, PublicServerUrl, ServerUrl, TokenKey } from './constants'

/**
 * 应用侧 HTTP 客户端装配。
 *
 * 机制（浏览器单例 / 服务端无状态客户端 / 凭证读写 / 401 时清凭证）在 `@repo/sdk` 的
 * `createAppClients`；这里只注入本应用的取值与**应用独有**的 401 善后策略 ——
 * 后台额外撤销服务端会话（清掉 httpOnly cookie，避免与登录页会话探测互相弹回形成死循环）
 * 并带 `reason=expired`，前台则直接回登录页。
 */
export const {
  getServerClient,
  useServerClient,
  createServerClient,
  saveToken,
  removeToken,
} = createAppClients({
  tokenKey: TokenKey,
  publicBaseUrl: PublicServerUrl,
  serverBaseUrl: ServerUrl,
  onUnauthorized: async () => {
    if (typeof window === 'undefined') return
    await logoutAction()
    window.location.replace(`${Pages.login}?reason=expired`)
  },
})
