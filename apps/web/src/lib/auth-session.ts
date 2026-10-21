import { cache } from 'react'
import { cookies } from 'next/headers'
import type { AuthUserModel } from '@repo/shared'
import { createServerClient } from './server-client'
import { TokenKey } from './constants'

/**
 * 后端探测的硬超时（毫秒）。
 *
 * 前台是**公开页面**：后端没起、正在迁移、或者卡死了，都不该让读者盯着白屏。
 * 原来没有超时，后端端口占着但不响应时，整个 SSR 会挂住一百多秒 —— 这在实际里就等于挂站。
 * 1.5s 足够一次正常的 `/config/get`，超了就走兜底逻辑。
 */
const AUTH_PROBE_TIMEOUT = 1500

function withTimeout<T>(task: Promise<T>, ms = AUTH_PROBE_TIMEOUT): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`auth probe timeout ${ms}ms`)), ms)
    // dev 下别让定时器拖住进程退出
    timer.unref?.()
    task.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * 用户体系开关（服务端）：调后端 `/config/get`。
 * 获取失败或超时保守按「开启」处理 —— 与 admin 的 `main/layout.tsx` / `proxy.ts` 同一策略。
 */
export const getAuthEnabled = cache(async (): Promise<boolean> => {
  try {
    const config = await withTimeout(createServerClient().config.get())
    return config.authEnabled
  } catch {
    return true
  }
})

/**
 * 服务端会话探测：读 httpOnly cookie（登录 / 注册时由 Server Action 写入）→ 调 `/auth/get-me`。
 * 无 cookie 或会话失效一律返回 null（前台不强制登录，首页按未登录渲染）。
 */
export const getAuthUser = cache(async (): Promise<AuthUserModel | null> => {
  const token = (await cookies()).get(TokenKey)?.value
  if (!token) return null

  try {
    return await withTimeout(createServerClient(token).auth.getMe())
  } catch {
    return null
  }
})

export type WebAuthState = {
  /** 用户体系开关：关闭时前端不渲染任何账号入口 */
  authEnabled: boolean
  /** 当前登录用户（null = 未登录 / 会话已失效） */
  user: AuthUserModel | null
}

/**
 * 页面级登录态：一次返回「开关 + 用户」，供 SSR 直接决定账号入口的渲染。
 * React `cache` 保证同一次请求内只请求后端一次（layout 与 page 共用不重复拉取）。
 */
export const getWebAuthState = cache(async (): Promise<WebAuthState> => {
  const authEnabled = await getAuthEnabled()
  return { authEnabled, user: authEnabled ? await getAuthUser() : null }
})
