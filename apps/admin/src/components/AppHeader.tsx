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
        'flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-background/80 px-4 backdrop-blur-sm sm:px-6',
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <SidebarTrigger className="-ml-1" />
        {title ? (
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {title}
            </span>
            {/* mono 路径：CLI 式定位，强化设计语言的「命令行精确感」 */}
            <span className="hidden truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground md:inline">
              {pathname}
            </span>
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <ThemeToggle />
      </div>
    </div>
  )
}
