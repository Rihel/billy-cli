'use client'

import {
  ServerClient,
  BearerTokenStrategy,
  type CredentialsManager,
} from '@repo/sdk'
import { authStorage } from './auth'
import { Pages } from './constants'

/**
 * 客户端用的 CredentialsManager — 从 localStorage 读取/写入 token
 */
class WebCredentialsManager implements CredentialsManager<{ token: string }> {
  async getCredentials(): Promise<{ token: string }> {
    const token = authStorage.getToken()
    return token ? { token } : ({} as { token: string })
  }
  async setCredentials(credentials: { token: string }): Promise<void> {
    authStorage.setToken(credentials.token)
  }
  async clearCredentials(): Promise<void> {
    authStorage.removeToken()
  }
}

let clientInstance: ServerClient<{ token: string }> | null = null

/**
 * 获取客户端 ServerClient 单例
 * SSR 期间也会创建实例，但不会真正发起请求（StorageProvider 等 context 需要它存在）。
 */
export function getServerClient(): ServerClient<{ token: string }> {
  if (!clientInstance) {
    clientInstance = new ServerClient({
      baseUrl: process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:9989',
      credentialsManager: new WebCredentialsManager(),
      authStrategy: new BearerTokenStrategy(),
      callbacks: {
        onUnauthorized: async () => {
          if (typeof window === 'undefined') return
          authStorage.removeToken()
          window.location.replace(Pages.login)
        },
      },
    })
  }
  return clientInstance
}

/**
 * React Hook — 获取当前客户端 ServerClient 实例
 */
export function useServerClient(): ServerClient<{ token: string }> {
  return getServerClient()
}
