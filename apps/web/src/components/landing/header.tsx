'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  LogOutIcon,
  Menu,
  SparklesIcon,
  TerminalSquare,
  X,
} from 'lucide-react'
import { Button } from '@repo/ui'
import {
  AppName,
  Pages,
  LandingAnchors,
  AdminUrl,
  formatStorageUrl,
} from '@/lib/constants'
import { removeToken } from '@/lib/server-client'
import { logoutAction } from '@/actions/auth.actions'
import { ThemeToggle } from '@/components/ThemeToggle'
import { cn } from '@repo/ui'
import type { AuthUserModel } from '@repo/shared'

const anchorLinks = [
  { href: LandingAnchors.why, label: '设计理念' },
  { href: LandingAnchors.features, label: '特性' },
  { href: LandingAnchors.choice, label: '选型' },
  { href: LandingAnchors.ai, label: 'AI 能力' },
  { href: LandingAnchors.architecture, label: '架构' },
  { href: LandingAnchors.quickstart, label: '快速开始' },
  { href: Pages.markdown, label: 'Markdown' },
]

export type HeaderProps = {
  /** 服务端探测到的登录用户（null = 未登录） */
  user: AuthUserModel | null
  /** 用户体系开关：关闭时不渲染登录 / 注册入口 */
  authEnabled: boolean
}

/** 首页顶部导航：单行锚点 + 登录/注册（登录后显示用户信息），移动端折叠为抽屉菜单 */
export function Header({ user, authEnabled }: HeaderProps) {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  const displayName = user?.realName || user?.email || ''
  const initial = displayName.charAt(0).toUpperCase() || 'U'

  const logout = async () => {
    await logoutAction()
    await removeToken()
    setOpen(false)
    // 登录态来自服务端 cookie，刷新 RSC 后 Header 自然回到未登录态
    router.refresh()
  }

  return (
    <header className="sticky top-0 z-50 border-b border-border/80 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* 品牌 */}
        <Link
          href={Pages.home}
          className="group flex items-center gap-2.5"
          aria-label={`${AppName} 首页`}
        >
          <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-violet-600 text-white shadow-md shadow-brand/25 transition-transform group-hover:scale-105">
            <TerminalSquare className="size-4.5" strokeWidth={2.2} />
          </span>
          <span className="font-heading text-[15px] font-semibold tracking-tight text-foreground">
            {AppName}
          </span>
        </Link>

        {/* 桌面导航 */}
        <nav className="hidden items-center gap-1 md:flex" aria-label="主导航">
          {anchorLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* 桌面操作：主题切换 + 登录后显示用户信息；未登录且用户体系开启时显示登录/注册 */}
        <div className="hidden items-center gap-2 md:flex">
          <ThemeToggle />
          {user ? (
            <>
              {/* AI 会话页入口（受保护页：未登录不会走到这里） */}
              <Button
                render={<Link href={Pages.aiChat} />}
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
              >
                <SparklesIcon />
                AI 助手
              </Button>
              <Link
                href={Pages.account}
                className="flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-muted"
                title={`进入个人中心（${displayName}）`}
              >
                {user.avatar ? (
                  <img
                    src={formatStorageUrl(user.avatar)}
                    alt=""
                    className="size-8 rounded-full object-cover"
                  />
                ) : (
                  <span className="grid size-8 place-items-center rounded-full bg-brand/10 text-sm font-medium text-brand">
                    {initial}
                  </span>
                )}
                <span className="max-w-32 truncate text-sm text-muted-foreground">
                  {displayName}
                </span>
              </Link>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => void logout()}
              >
                <LogOutIcon />
                退出
              </Button>
            </>
          ) : authEnabled ? (
            <>
              <Link
                href={Pages.login}
                className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                登录
              </Link>
              <Button
                render={<Link href={Pages.register} />}
                size="sm"
                className="bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
              >
                注册
                <ArrowRight data-icon="inline-end" />
              </Button>
            </>
          ) : null}
        </div>

        {/* 移动端菜单按钮 */}
        <button
          type="button"
          className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
          aria-label={open ? '关闭菜单' : '打开菜单'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>

      {/* 移动端抽屉 */}
      <div
        className={cn(
          'overflow-hidden border-border/80 transition-[max-height,opacity] duration-300 ease-out md:hidden',
          open ? 'max-h-96 border-t opacity-100' : 'max-h-0 opacity-0',
        )}
      >
        <nav className="space-y-1 px-4 py-4" aria-label="移动端导航">
          {anchorLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
          {user ? (
            <div className="mt-3 flex items-center gap-2 border-t border-border/80 pt-3">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {user.avatar ? (
                  <img
                    src={formatStorageUrl(user.avatar)}
                    alt=""
                    className="size-8 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand/10 text-sm font-medium text-brand">
                    {initial}
                  </span>
                )}
                <span className="truncate text-sm text-muted-foreground">
                  {displayName}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-muted-foreground"
                onClick={() => {
                  setOpen(false)
                  void logout()
                }}
              >
                <LogOutIcon />
                退出
              </Button>
            </div>
          ) : authEnabled ? (
            <div className="mt-3 flex items-center gap-2 border-t border-border/80 pt-3">
              <Link
                href={Pages.login}
                onClick={() => setOpen(false)}
                className="flex-1 rounded-lg px-3 py-2 text-center text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                登录
              </Link>
              <Button
                render={<Link href={Pages.register} onClick={() => setOpen(false)} />}
                size="sm"
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                注册
              </Button>
            </div>
          ) : null}
          <a
            href={AdminUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
            className="block rounded-lg px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            前往管理后台 <span className="text-muted-foreground">↗</span>
          </a>
          {/* 主题切换（移动端：左侧文字 + 右侧图标按钮） */}
          <div className="flex items-center justify-between rounded-lg px-3 py-2.5">
            <span className="text-sm text-muted-foreground">主题</span>
            <ThemeToggle />
          </div>
        </nav>
      </div>
    </header>
  )
}
