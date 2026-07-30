import {
  ServerClient,
  BearerTokenStrategy,
  LocalStorageCredentialsManager,
  MemoryCredentialsManager,
} from '@repo/sdk'
import { Pages, ServerUrl, TokenKey } from './constants'

const tokenManager = new LocalStorageCredentialsManager<{ token: string }>(
  TokenKey,
)

export async function saveToken(token: string): Promise<void> {
  await tokenManager.setCredentials({ token })
}

export async function removeToken(): Promise<void> {
  await tokenManager.clearCredentials()
}

let clientInstance: ServerClient<{ token: string }> | null = null

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

export function useServerClient(): ServerClient<{ token: string }> {
  return getServerClient()
}

export function createServerClient(token?: string) {
  const mgr = new MemoryCredentialsManager<{ token: string }>()
  if (token) mgr.setCredentials({ token })

  return new ServerClient({
    baseUrl: ServerUrl,
    credentialsManager: mgr,
    authStrategy: new BearerTokenStrategy(),
    callbacks: {
      onUnauthorized: async () => {},
    },
  })
}
