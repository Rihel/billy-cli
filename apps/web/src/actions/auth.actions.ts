'use server'

import { cookies } from 'next/headers'
import { authCookieOptions } from '@repo/shared'
import { ApiError } from '@repo/http-client'
import { defineAction } from '@repo/ui/action'
import { createServerClient } from '@/lib/server-client'
import { TokenKey } from '@/lib/constants'

const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 // 7 天

/** 安全默认（httpOnly / sameSite / path / secure）在 `@repo/shared`，这里只给取值 */
function cookieOptions(maxAge: number) {
  return authCookieOptions({
    maxAge,
    secure: process.env.NODE_ENV === 'production',
  })
}

/** 错误文案归一：后端错误用其中文提示，其余兜底（与 admin 的 defineAction 用法一致） */
function getError(error: unknown) {
  return error instanceof ApiError ? error.message : '操作失败，请稍后重试'
}

export const loginAction = defineAction(
  async (input: { email: string; password: string }) => {
    const client = createServerClient()
    const data = await client.auth.login(input)
    const jar = await cookies()
    jar.set(TokenKey, data.token, cookieOptions(COOKIE_MAX_AGE))
    return data
  },
  { fallbackError: '登录失败', getError },
)

export const registerAction = defineAction(
  async (input: { email: string; password: string; realName?: string }) => {
    const client = createServerClient()
    const data = await client.auth.register(input)
    const jar = await cookies()
    jar.set(TokenKey, data.token, cookieOptions(COOKIE_MAX_AGE))
    return data
  },
  { fallbackError: '注册失败', getError },
)

export const forgotPasswordAction = defineAction(
  async (input: { email: string }) => {
    const client = createServerClient()
    return client.auth.forgotPassword(input)
  },
  { fallbackError: '操作失败，请稍后重试', getError },
)

export const resetPasswordAction = defineAction(
  async (input: { token: string; password: string }) => {
    const client = createServerClient()
    return client.auth.resetPassword(input)
  },
  { fallbackError: '操作失败，请稍后重试', getError },
)

/**
 * 登出：撤销服务端会话（幂等）+ 清理 httpOnly cookie。
 *
 * `try / catch / finally` 三件都不能少：撤销会话失败**不能阻断登出**，
 * 而 cookie 必须在 `finally` 里清掉 —— 否则用户看起来还登录着（cookie 在），
 * 但服务端会话已失效，之后每个请求都 401。
 */
export async function logoutAction() {
  const jar = await cookies()
  const token = jar.get(TokenKey)?.value
  try {
    if (token) {
      await createServerClient(token).auth.logout()
    }
  } catch {
    // 撤销失败不阻断登出：cookie 仍会在 finally 里清掉，重登即可
  } finally {
    jar.delete(TokenKey)
  }
}
