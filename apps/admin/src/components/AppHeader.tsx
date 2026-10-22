'use client'

import { usePathname } from 'next/navigation'
import { cn, SidebarTrigger } from '@repo/ui'
import { ComponentProps } from 'react'
import { ThemeToggle } from './ThemeToggle'

/** 路由 → 页面标题（与 AppMenu 菜单项一致） */
const PAGE_TITLES: Record<string, string> = {
  '/main/dashboard': '控制台',
  '/main/monitor/rules': '告警规则',
  '/main/monitor/logs': '告警记录',
  '/main/system/users': '用户管理',
  '/main/system/admins': '管理员管理',
  '/main/user-center': '个人中心',
}

/**
 * 取当前页标题：**先精确匹配，再逐段回退**。
 *
 * 回退是为了详情页（`/main/xxx/<id>` / `/main/tools/<id>/edit`）—— 它们没有独立标题，
 * 但页头空着会让人不知道自己在哪一层；回退到最近的一个已知父级即可。
 */
const titleOf = (pathname: string): string => {
  const exact = PAGE_TITLES[pathname]
  if (exact) return exact
  const segments = pathname.split('/').filter(Boolean)
  while (segments.length > 1) {
    segments.pop()
    const found = PAGE_TITLES[`/${segments.join('/')}`]
    if (found) return found
  }
  return ''
}

export type AppHeaderProps = Partial<{} & ComponentProps<'div'>>

export const AppHeader = ({ className, ...props }: AppHeaderProps) => {
  const pathname = usePathname()
  const title = titleOf(pathname)

  return (
    <div
      className={cn(
        'flex h-12 shrink-0 items-center justify-between gap-3 bg-background/85 px-4 backdrop-blur-sm sm:px-6',
        className,
      )}
      {...props}
    >
      {/* 左：折叠 + 当前页标题 */}
      <div className="flex min-w-0 items-center gap-2.5">
        <SidebarTrigger className="-ml-1" />
        {title ? (
          <span className="font-heading truncate text-sm font-medium tracking-tight text-foreground">
            {title}
          </span>
        ) : null}
      </div>

      {/* 右：主题 */}
      <div className="flex shrink-0 items-center gap-1.5">
        <ThemeToggle />
      </div>
    </div>
  )
}
