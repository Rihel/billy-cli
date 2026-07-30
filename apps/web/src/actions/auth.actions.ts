'use server'

import { cookies } from 'next/headers'
import { createServerClient } from '@/lib/server-client'
import { TokenKey } from '@/lib/constants'
import { ApiError } from '@repo/sdk'

const COOKIE_MAX_AGE = 7 * 24 * 60 * 60

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
    secure: process.env.NODE_ENV === 'production',
  }
}

export type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string }

function wrapAction<T>(fn: () => Promise<T>): () => Promise<ActionResult<T>>
function wrapAction<T, I>(
  fn: (input: I) => Promise<T>,
): (input: I) => Promise<ActionResult<T>>
function wrapAction<T, I>(
  fn: (input?: I) => Promise<T>,
): (input?: I) => Promise<ActionResult<T>> {
  return async function (input?: I): Promise<ActionResult<T>> {
    try {
      const data = await fn(input)
      return { success: true, data }
    } catch (err) {
      if (err instanceof ApiError) {
        return { success: false, error: err.message }
      }
      return { success: false, error: '操作失败，请稍后重试' }
    }
  }
}

export const loginAction = wrapAction(
  async (input: { email: string; password: string }) => {
    const client = createServerClient()
    const data = await client.auth.login(input)
    const jar = await cookies()
    jar.set(TokenKey, data.token, cookieOptions(COOKIE_MAX_AGE))
    return data
  },
)

export const registerAction = wrapAction(
  async (input: {
    email: string
    password: string
    realName?: string
  }) => {
    const client = createServerClient()
    const data = await client.auth.register(input)
    const jar = await cookies()
    jar.set(TokenKey, data.token, cookieOptions(COOKIE_MAX_AGE))
    return data
  },
)
