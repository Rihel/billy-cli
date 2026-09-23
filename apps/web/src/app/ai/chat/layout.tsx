import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AppName, Pages } from '@/lib/constants'
import { getWebAuthState } from '@/lib/auth-session'

export const metadata: Metadata = {
  title: `AI 助手 - ${AppName}`,
}

/**
 * AI 会话页的布局：**SSR 会话校验**（读 httpOnly cookie → `/auth/get-me`）。
 *
 * 为什么这一页必须登录才能进：会话、运行、时间线全部**按用户归属**（服务端从鉴权上下文取 userId，
 * 不接受前端传），未登录进来只会拿到 401/404 的空壳。这里与 `account/layout.tsx` 同一模式，
 * 页面组件因此不必重复判断登录态，也不会出现"先渲染再跳转"的闪烁。
 *
 * 边缘守卫（`proxy.ts` 的 matcher 已含 `/ai/:path*`）只查 cookie 是否存在，负责发出真正的 307；
 * "cookie 在但服务端会话已失效"由这里兜住。
 */
export default async function AiChatLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { authEnabled, user } = await getWebAuthState()

  if (!authEnabled) redirect(Pages.home)
  if (!user) {
    redirect(`${Pages.login}?next=${encodeURIComponent(Pages.aiChat)}`)
  }

  return <div className="min-h-screen bg-background text-foreground">{children}</div>
}
