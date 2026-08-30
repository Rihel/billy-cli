import { ServerClient } from '@repo/sdk'
import {
  LocalStorageCredentialsManager,
  MemoryCredentialsManager,
  BearerTokenCredentials,
} from '@repo/http-client'
import { logoutAction } from '@/actions/auth.actions'
import { Pages, ServerUrl, TokenKey } from './constants'

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

export function getServerClient(): ServerClient {
  if (!clientInstance) {
    clientInstance = new ServerClient({
      baseUrl: ServerUrl,
      credentialsManager: tokenManager,
      callbacks: {
        onUnauthorized: async () => {
          if (typeof window === 'undefined') return
          tokenManager.clearCredentials()
          // 同时清掉 httpOnly cookie，避免与登录页会话探测互相弹回形成死循环
          await logoutAction()
          window.location.replace(`${Pages.login}?reason=expired`)
        },
      },
    })
  }
  return clientInstance
}

export function useServerClient(): ServerClient {
  return getServerClient()
}

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
