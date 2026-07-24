'use server'

import { cookies } from 'next/headers'
import { serverTRPC } from '@/lib/server-trpc'
import { TokenKey } from '@/lib/constants'
import { logger } from '@/lib/logger'

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

export async function loginAction(input: { email: string; password: string }) {
  try {
    const data = await serverTRPC.auth.login.mutate(input)
    const jar = await cookies()
    jar.set(TokenKey, data.token, cookieOptions(COOKIE_MAX_AGE))
    return { ok: true as const, data: data.token }
  } catch (error: any) {
    logger.error('loginAction error', { error })
    return { ok: false as const, error: error?.message ?? '登录失败' }
  }
}

export async function registerAction(input: {
  email: string
  password: string
  realName?: string
}) {
  try {
    const data = await serverTRPC.auth.register.mutate(input)
    const jar = await cookies()
    jar.set(TokenKey, data.token, cookieOptions(COOKIE_MAX_AGE))
    return { ok: true as const, data: data.token }
  } catch (error: any) {
    logger.error('registerAction error', { error })
    return { ok: false as const, error: error?.message ?? '注册失败' }
  }
}

export async function forgotPasswordAction(input: { email: string }) {
  try {
    const data = await serverTRPC.auth.forgotPassword.mutate(input)
    return { ok: true as const, data }
  } catch (error: any) {
    logger.error('forgotPasswordAction error', { error })
    return { ok: false as const, error: error?.message ?? '请求失败' }
  }
}

export async function resetPasswordAction(input: {
  token: string
  password: string
}) {
  try {
    const data = await serverTRPC.auth.resetPassword.mutate(input)
    return { ok: true as const, data }
  } catch (error: any) {
    logger.error('resetPasswordAction error', { error })
    return { ok: false as const, error: error?.message ?? '重置失败' }
  }
}

export async function logoutAction() {
  const jar = await cookies()
  jar.delete(TokenKey)
}
