'use server'

import { cookies } from 'next/headers'
import { authCookieOptions } from '@repo/shared'
import { createServerClient } from '@/lib/server-client'
import { TokenKey } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { defineAction } from '@repo/ui/action'

const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 // 7 days

/** 安全默认（httpOnly / sameSite / path / secure）在 `@repo/shared`，这里只给取值 */
function cookieOptions(maxAge: number) {
  return authCookieOptions({
    maxAge,
    secure: process.env.NODE_ENV === 'production',
  })
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

/**
 * 登出：撤销服务端会话（幂等，会话已失效时也安全）+ 清理 httpOnly cookie。
 * 供登出入口与 onUnauthorized 共用 —— 不会因 401 循环。
 */
export async function logoutAction() {
  const jar = await cookies()
  const token = jar.get(TokenKey)?.value
  try {
    if (token) {
      const client = createServerClient(token)
      await client.admin.logout()
    }
  } catch (error) {
    logger.warn('logoutAction: 服务端会话撤销失败', { error })
  } finally {
    jar.delete(TokenKey)
  }
}
