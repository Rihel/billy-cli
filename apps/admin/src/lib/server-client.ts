import {
  ServerClient,
  BearerTokenStrategy,
  MemoryCredentialsManager,
  LocalStorageCredentialsManager,
} from '@repo/sdk'
import { Pages, ServerUrl, TokenKey } from './constants'

// ── Token 存储 ─────────────────────────────────────

const tokenManager = new LocalStorageCredentialsManager<{ token: string }>(
  TokenKey,
)

/** 登录成功后保存 token */
export async function saveToken(token: string): Promise<void> {
  await tokenManager.setCredentials({ token })
}

/** 退出登录时清除 token */
export async function removeToken(): Promise<void> {
  await tokenManager.clearCredentials()
}

// ── 客户端（浏览器端） ────────────────────────────────

let clientInstance: ServerClient<{ token: string }> | null = null

/** 浏览器端 ServerClient 单例 */
export function getServerClient(): ServerClient<{ token: string }> {
  if (!clientInstance) {
    clientInstance = new ServerClient({
      baseUrl: ServerUrl,
      credentialsManager: tokenManager,
      authStrategy: new BearerTokenStrategy(),
      callbacks: {
        onUnauthorized: async () => {
          if (typeof window === 'undefined') return
          tokenManager.clearCredentials()
          window.location.replace(Pages.login)
        },
      },
    })
  }
  return clientInstance
}

/** React Hook */
export function useServerClient(): ServerClient<{ token: string }> {
  return getServerClient()
}

// ── 服务端（Server Actions / Server Components） ──────

/**
 * 创建服务端 ServerClient。
 * 优先使用传入的 token，否则从 httpOnly cookie 读取。
 */
export function createServerClient(token?: string) {
  const mgr = new MemoryCredentialsManager<{ token: string }>()
  if (token) mgr.setCredentials({ token })

  return new ServerClient({
    baseUrl: ServerUrl,
    credentialsManager: mgr,
    authStrategy: new BearerTokenStrategy(),
    callbacks: {
      onUnauthorized: async () => {
        // 服务端不做跳转，由调用方处理
      },
    },
  })
}

/** 从 httpOnly cookie 读取 token 并创建服务端客户端 */
export async function createServerClientFromCookies() {
  const { cookies } = await import('next/headers')
  const jar = await cookies()
  const token = jar.get(TokenKey)?.value
  return createServerClient(token)
}
