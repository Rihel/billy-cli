'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { LogOutIcon, Menu, X, ArrowRight, TerminalSquare } from 'lucide-react'
import { Button } from '@repo/ui'
import {
  AppName,
  Pages,
  LandingAnchors,
  AdminUrl,
  TokenKey,
  formatStorageUrl,
} from '@/lib/constants'
import {
  useServerClient,
  createServerClient,
  removeToken,
} from '@/lib/server-client'
import { logoutAction } from '@/actions/auth.actions'
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

/** 首页顶部导航：单行锚点 + 登录/注册（登录后显示用户信息），移动端折叠为抽屉菜单 */
export function Header() {
  const [open, setOpen] = useState(false)
  const client = useServerClient()
  // 用户体系开关：调 /config/get 获取，默认开启（获取失败保持现状，不阻塞页面）
  const [authEnabled, setAuthEnabled] = useState(true)
  // 当前登录用户（null = 未登录）
  const [user, setUser] = useState<AuthUserModel | null>(null)

  useEffect(() => {
    let cancelled = false
    client.config
      .get()
      .then((config) => {
        if (cancelled) return
        // 同步到业务请求所用 client 实例：关闭时跳过前端凭证校验，交由后端守卫判断
        client.setAuthEnabled(config.authEnabled)
        setAuthEnabled(config.authEnabled)
      })
      .catch(() => {
        // 获取失败保持默认（开启）
      })
    return () => {
      cancelled = true
    }
  }, [client])

  // 登录态探测：读 localStorage 凭证 → getMe 拉取用户信息；token 失效则清理回未登录
  useEffect(() => {
    let cancelled = false
    let token = ''
    try {
      const raw = localStorage.getItem(TokenKey)
      token = raw ? (JSON.parse(raw)?.token ?? '') : ''
    } catch {
      token = ''
    }
    if (!token) {
      setUser(null)
      return
    }
    createServerClient(token)
      .auth.getMe()
      .then((me) => {
        if (!cancelled) setUser(me)
      })
      .catch(() => {
        // token 失效：清理本地凭证，回到未登录态（不跳转，避免干扰当前浏览）
        localStorage.removeItem(TokenKey)
        if (!cancelled) setUser(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const displayName = user?.realName || user?.email || ''
  const initial = displayName.charAt(0).toUpperCase() || 'U'

  const logout = async () => {
    await logoutAction()
    await removeToken()
    setUser(null)
  }

  return (
    <header className="sticky top-0 z-50 border-b border-zinc-200/80 bg-white/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* 品牌 */}
        <Link
          href={Pages.home}
          className="group flex items-center gap-2.5"
          aria-label={`${AppName} 首页`}
        >
          <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-600/25 transition-transform group-hover:scale-105">
            <TerminalSquare className="size-4.5" strokeWidth={2.2} />
          </span>
          <span className="font-heading text-[15px] font-semibold tracking-tight text-zinc-900">
            {AppName}
          </span>
        </Link>

        {/* 桌面导航 */}
        <nav className="hidden items-center gap-1 md:flex" aria-label="主导航">
          {anchorLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-lg px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* 桌面操作：登录后显示用户信息；未登录且用户体系开启时显示登录/注册 */}
        <div className="hidden items-center gap-2 md:flex">
          {user ? (
            <>
              <div className="flex items-center gap-2" title={displayName}>
                {user.avatar ? (
                  <img
                    src={formatStorageUrl(user.avatar)}
                    alt=""
                    className="size-8 rounded-full object-cover"
                  />
                ) : (
                  <span className="grid size-8 place-items-center rounded-full bg-indigo-500/10 text-sm font-medium text-indigo-700">
                    {initial}
                  </span>
                )}
                <span className="max-w-32 truncate text-sm text-zinc-600">
                  {displayName}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-zinc-500 hover:text-zinc-900"
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
                className="rounded-md px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
              >
                登录
              </Link>
              <Button
                render={<Link href={Pages.register} />}
                size="sm"
                className="bg-zinc-950 px-3.5 text-white shadow-sm shadow-zinc-950/15 hover:bg-zinc-800"
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
          className="inline-flex size-9 items-center justify-center rounded-lg text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 md:hidden"
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
          'overflow-hidden border-zinc-200/80 transition-[max-height,opacity] duration-300 ease-out md:hidden',
          open ? 'max-h-96 border-t opacity-100' : 'max-h-0 opacity-0',
        )}
      >
        <nav className="space-y-1 px-4 py-4" aria-label="移动端导航">
          {anchorLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="block rounded-lg px-3 py-2.5 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
            >
              {link.label}
            </Link>
          ))}
          {user ? (
            <div className="mt-3 flex items-center gap-2 border-t border-zinc-200/80 pt-3">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {user.avatar ? (
                  <img
                    src={formatStorageUrl(user.avatar)}
                    alt=""
                    className="size-8 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-indigo-500/10 text-sm font-medium text-indigo-700">
                    {initial}
                  </span>
                )}
                <span className="truncate text-sm text-zinc-600">
                  {displayName}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-zinc-500"
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
            <div className="mt-3 flex items-center gap-2 border-t border-zinc-200/80 pt-3">
              <Link
                href={Pages.login}
                onClick={() => setOpen(false)}
                className="flex-1 rounded-lg px-3 py-2 text-center text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
              >
                登录
              </Link>
              <Button
                render={<Link href={Pages.register} onClick={() => setOpen(false)} />}
                size="sm"
                className="flex-1 bg-zinc-950 text-white hover:bg-zinc-800"
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
            className="block rounded-lg px-3 py-2.5 text-sm text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            前往管理后台 <span className="text-zinc-400">↗</span>
          </a>
        </nav>
      </div>
    </header>
  )
}
