'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@repo/ui'
import { Pages } from '@/lib/constants'

const items = [
  { href: Pages.account, label: '账号资料' },
  { href: `${Pages.account}/sessions`, label: '登录设备' },
]

/** 个人中心区段导航（当前页高亮）；受保护状态由 account/layout.tsx 统一守卫 */
export function AccountNav() {
  const pathname = usePathname()

  return (
    <nav
      className="border-b border-border bg-background/80 backdrop-blur"
      aria-label="个人中心导航"
    >
      <div className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-4 sm:px-6">
        {items.map((item) => {
          const active = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'border-b-2 px-3 py-3 text-sm whitespace-nowrap transition-colors',
                active
                  ? 'border-foreground font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
