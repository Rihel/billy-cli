'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Menu, X, ArrowRight, TerminalSquare } from 'lucide-react'
import { Button } from '@repo/ui'
import { AppName, Pages, LandingAnchors, AdminUrl } from '@/lib/constants'
import { useServerClient } from '@/lib/server-client'
import { cn } from '@repo/ui'

const anchorLinks = [
  { href: LandingAnchors.features, label: '特性' },
  { href: LandingAnchors.ai, label: 'AI 能力' },
  { href: LandingAnchors.architecture, label: '架构' },
  { href: LandingAnchors.quickstart, label: '快速开始' },
  { href: Pages.markdown, label: 'Markdown' },
]

/** 首页顶部导航：单行锚点 + 登录/注册，移动端折叠为抽屉菜单 */
export function Header() {
  const [open, setOpen] = useState(false)
  const client = useServerClient()
  // 用户体系开关：调 /config/get 获取，默认开启（获取失败保持现状，不阻塞页面）
  const [authEnabled, setAuthEnabled] = useState(true)

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

  return (
    <header className="sticky top-0 z-50 border-b border-zinc-200/80 bg-white/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* 品牌 */}
        <Link
          href={Pages.home}
          className="group flex items-center gap-2.5"
          aria-label={`${AppName} 首页`}
        >
          <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 text-white shadow-md shadow-orange-500/25 transition-transform group-hover:scale-105">
            <TerminalSquare className="size-4.5" strokeWidth={2.2} />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-zinc-900">
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

        {/* 桌面操作：用户体系开关关闭时隐藏登录/注册入口 */}
        <div className="hidden items-center gap-2 md:flex">
          {authEnabled ? (
            <>
              <Button
                render={<Link href={Pages.login} />}
                variant="ghost"
                size="sm"
                className="text-zinc-600 hover:text-zinc-900"
              >
                登录
              </Button>
              <Button
                render={<Link href={Pages.register} />}
                size="sm"
                className="bg-orange-500 text-white shadow-md shadow-orange-500/20 hover:bg-orange-600"
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
          {authEnabled ? (
            <div className="mt-3 flex items-center gap-2 border-t border-zinc-200/80 pt-3">
              <Button
                render={<Link href={Pages.login} onClick={() => setOpen(false)} />}
                variant="ghost"
                size="sm"
                className="flex-1 text-zinc-600"
              >
                登录
              </Button>
              <Button
                render={<Link href={Pages.register} onClick={() => setOpen(false)} />}
                size="sm"
                className="flex-1 bg-orange-500 text-white hover:bg-orange-600"
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
