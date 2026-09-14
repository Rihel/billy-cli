import { ServerClient } from '@repo/sdk'
import {
  LocalStorageCredentialsManager,
  MemoryCredentialsManager,
  BearerTokenCredentials,
} from '@repo/http-client'
import { Pages, PublicServerUrl, ServerUrl, TokenKey } from './constants'

const tokenManager = new LocalStorageCredentialsManager<BearerTokenCredentials>(
  TokenKey,
)

export async function saveToken(token: string): Promise<void> {
  await tokenManager.setCredentials({ token })
}

export async function removeToken(): Promise<void> {
  await tokenManager.clearCredentials()
}

let clientInstance: ServerClient | null = null

/** 浏览器端单例（localStorage 存 token）；走浏览器可达的公开地址 */
export function getServerClient(): ServerClient {
  if (!clientInstance) {
    clientInstance = new ServerClient({
      baseUrl: PublicServerUrl,
      credentialsManager: tokenManager,
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

export function useServerClient(): ServerClient {
  return getServerClient()
}

/** 服务端（SSR / Server Actions）无状态客户端；走运行时 SERVER_URL，容器内可指内网 */
export function createServerClient(token?: string) {
  const mgr = new MemoryCredentialsManager<BearerTokenCredentials>()
  if (token) mgr.setCredentials({ token })

  return new ServerClient({
    baseUrl: ServerUrl,
    credentialsManager: mgr,
    callbacks: {
      onUnauthorized: async () => {},
    },
  })
}
