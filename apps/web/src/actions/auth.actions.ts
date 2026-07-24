'use server'

import { cookies } from 'next/headers'
import { serverTRPC } from '@/lib/server-trpc'
import { TokenKey } from '@/lib/constants'

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
  const data = await serverTRPC.auth.login.mutate(input)
  const jar = await cookies()
  jar.set(TokenKey, data.token, cookieOptions(COOKIE_MAX_AGE))
  return data.token
}

export async function registerAction(input: {
  email: string
  password: string
  realName?: string
}) {
  const data = await serverTRPC.auth.register.mutate(input)
  const jar = await cookies()
  jar.set(TokenKey, data.token, cookieOptions(COOKIE_MAX_AGE))
  return data.token
}

export async function forgotPasswordAction(input: { email: string }) {
  return serverTRPC.auth.forgotPassword.mutate(input)
}

export async function resetPasswordAction(input: {
  token: string
  password: string
}) {
  return serverTRPC.auth.resetPassword.mutate(input)
}

export async function logoutAction() {
  const jar = await cookies()
  jar.delete(TokenKey)
}
