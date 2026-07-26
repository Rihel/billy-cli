'use server'

import { cookies } from 'next/headers'
import { serverTRPC } from '@/lib/server-trpc'
import { TokenKey } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { defineAction } from '@repo/ui/action'

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
    const data = await serverTRPC.auth.login.mutate(input)
    const jar = await cookies()
    jar.set(TokenKey, data.token, cookieOptions(COOKIE_MAX_AGE))
    return data.token
  },
  {
    fallbackError: '登录失败',
    onError: (error) => logger.error('loginAction error', { error }),
  },
)

export const registerAction = defineAction(
  async (input: { email: string; password: string; realName?: string }) => {
    const data = await serverTRPC.auth.register.mutate(input)
    const jar = await cookies()
    jar.set(TokenKey, data.token, cookieOptions(COOKIE_MAX_AGE))
    return data.token
  },
  {
    fallbackError: '注册失败',
    onError: (error) => logger.error('registerAction error', { error }),
  },
)

export const forgotPasswordAction = defineAction(
  (input: { email: string }) => serverTRPC.auth.forgotPassword.mutate(input),
  {
    fallbackError: '请求失败',
    onError: (error) => logger.error('forgotPasswordAction error', { error }),
  },
)

export const resetPasswordAction = defineAction(
  (input: { token: string; password: string }) =>
    serverTRPC.auth.resetPassword.mutate(input),
  {
    fallbackError: '重置失败',
    onError: (error) => logger.error('resetPasswordAction error', { error }),
  },
)

export async function logoutAction() {
  const jar = await cookies()
  jar.delete(TokenKey)
}
