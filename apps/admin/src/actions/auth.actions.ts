'use server'

import { cookies } from 'next/headers'
import { createServerClient } from '@/lib/server-client'
import { TokenKey } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { defineAction } from '@repo/aui/action'

const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 // 7 days

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
    secure: process.env.NODE_ENV === 'production',
  }
}

export const loginAction = defineAction(
  async (input: { email: string; password: string }) => {
    const client = createServerClient()
    const data = await client.admin.login(input)
    const jar = await cookies()
    jar.set(TokenKey, data.token, cookieOptions(COOKIE_MAX_AGE))
    return data.token
  },
  {
    fallbackError: '登录失败',
    onError: (error) => logger.error('loginAction error', { error }),
  },
)

/**
 * 会话探测：用 cookie 里的 token 调 admin.getMe()。
 * 登录页挂载时调用 —— 有效则进入主界面，失效则清理 cookie，避免与 SSR 守卫互相弹回形成死循环。
 */
export const checkSessionAction = defineAction<undefined, boolean>(
  async () => {
    const jar = await cookies()
    const token = jar.get(TokenKey)?.value
    if (!token) return false
    const client = createServerClient(token)
    await client.admin.getMe()
    return true
  },
  {
    fallbackError: '会话检测失败',
    onError: (error) => logger.warn('checkSessionAction error', { error }),
  },
)

export async function logoutAction() {
  const jar = await cookies()
  jar.delete(TokenKey)
}
