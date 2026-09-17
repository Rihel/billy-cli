import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeftIcon } from 'lucide-react'
import { getWebAuthState } from '@/lib/auth-session'
import { AppName, Pages } from '@/lib/constants'

export const metadata: Metadata = {
  title: `个人中心 - ${AppName}`,
}

/**
 * 受保护用户区（前台第一处需要登录态的页面）的布局：
 *
 * 在 SSR 侧做**会话校验**（读 httpOnly cookie → `auth.getMe()`），与 admin 的 `main/layout.tsx`
 * 同一模式 —— 页面组件本身不必重复判断登录态，也不必担心「先渲染再跳转」的闪烁。
 *
 * 两种跳转语义不同：
 * - 用户体系关闭（`AUTH_ENABLED=false`）：本页无意义（没有账号概念），回首页；
 * - 未登录 / 会话失效：去登录页并带 `?next=`，登录后回跳本页。
 */
export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { authEnabled, user } = await getWebAuthState()

  if (!authEnabled) redirect(Pages.home)
  if (!user) {
    redirect(`${Pages.login}?next=${encodeURIComponent(Pages.account)}`)
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4 sm:px-6">
          <Link
            href={Pages.home}
            className="inline-flex items-center gap-2 text-sm text-zinc-500 transition-colors hover:text-zinc-900"
          >
            <ArrowLeftIcon className="size-4" />
            {AppName}
          </Link>
          <span className="text-sm font-medium tracking-tight">个人中心</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">{children}</main>
    </div>
  )
}
