'use client'

import { usePathname } from 'next/navigation'
import { cn, SidebarTrigger } from '@repo/ui'
import { ComponentProps } from 'react'
import { ThemeToggle } from './ThemeToggle'

/** 路由 → 页面标题（与 AppMenu 菜单项一致） */
const PAGE_TITLES: Record<string, string> = {
  '/main/dashboard': '控制台',
  '/main/todo': '任务管理',
  '/main/automation': '自动化',
  '/main/monitor/rules': '告警规则',
  '/main/monitor/logs': '告警记录',
  '/main/system/users': '用户管理',
  '/main/system/admins': '管理员管理',
  '/main/user-center': '个人中心',
}

export type AppHeaderProps = Partial<{} & ComponentProps<'div'>>

export const AppHeader = ({ className, ...props }: AppHeaderProps) => {
  const pathname = usePathname()
  const title = PAGE_TITLES[pathname] ?? ''

  return (
    <div
      className={cn(
        'flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-background/95 px-4 backdrop-blur-sm sm:px-6',
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
