import {
  ServerClient,
  BearerTokenStrategy,
  MemoryCredentialsManager,
} from '@repo/sdk'
import { TokenKey } from './constants'

/**
 * 服务端用的 ServerClient — 用于 Server Actions 和 Server Components
 *
 * 优先使用传入的 token，否则从 httpOnly cookie 读取。
 *
 * @example
 * ```ts
 * // Server Actions
 * const client = createServerClient()
 * const user = await client.auth.getMe()
 * ```
 */
export function createServerClient(token?: string) {
  const credentialsManager = new MemoryCredentialsManager<{ token: string }>()

  if (token) {
    credentialsManager.setCredentials({ token })
  }

  const client = new ServerClient({
    baseUrl: process.env.SERVER_URL || 'http://localhost:9989',
    credentialsManager,
    authStrategy: new BearerTokenStrategy(),
    callbacks: {
      onUnauthorized: async () => {
        // Server-side unauthorized — handled by the caller (redirect, etc.)
      },
    },
  })

  return client
}

/**
 * 从 next/headers cookies 获取 token 并创建客户端
 */
export async function createServerClientFromCookies() {
  const { cookies } = await import('next/headers')
  const jar = await cookies()
  const token = jar.get(TokenKey)?.value
  return createServerClient(token)
}
