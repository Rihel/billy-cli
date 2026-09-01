'use client'

import { usePathname } from 'next/navigation'
import { cn, SidebarTrigger } from '@repo/ui'
import { ComponentProps } from 'react'

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
        'flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur-sm sm:px-6',
        className,
      )}
      {...props}
    >
      <SidebarTrigger className="-ml-1" />
      {title ? (
        <span className="text-sm font-medium text-muted-foreground">
          {title}
        </span>
      ) : null}
    </div>
  )
}
