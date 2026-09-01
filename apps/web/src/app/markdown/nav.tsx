'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@repo/ui'
import { Pages } from '@/lib/constants'

const items = [
  { href: '/markdown/basic', label: '基础语法' },
  { href: '/markdown/gfm', label: 'GFM 扩展' },
  { href: '/markdown/code', label: '代码高亮' },
  { href: '/markdown/article', label: '完整文档' },
]

/** Markdown 演示区段导航：返回首页 + 页面切换（当前页高亮） */
export function MarkdownNav() {
  const pathname = usePathname()
  return (
    <header className="sticky top-0 z-50 border-b border-zinc-200/80 bg-white/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link
          href={Pages.home}
          className="shrink-0 text-sm text-zinc-500 transition-colors hover:text-zinc-900"
        >
          <span aria-hidden="true">← </span>返回首页
        </Link>
        <nav
          className="flex items-center gap-1 overflow-x-auto"
          aria-label="Markdown 演示导航"
        >
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors',
                pathname === item.href
                  ? 'bg-zinc-900 font-medium text-white'
                  : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  )
}
