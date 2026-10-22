'use client'

import { usePathname } from 'next/navigation'
import { cn, SidebarTrigger } from '@repo/ui'
import { ComponentProps } from 'react'
import { menuTitleOf } from './AppMenu'
import { ThemeToggle } from './ThemeToggle'

/** 菜单之外的独立页面（个人中心在侧栏底部入口里） */
const EXTRA_TITLES: Record<string, string> = {
  '/main/user-center': '个人中心',
}

/**
 * 取当前页标题：标题来源是**侧栏菜单本身**（`menuTitleOf`），菜单之外的页面查 `EXTRA_TITLES`。
 *
 * 详情页（`/main/xxx/<id>` / `/main/tools/<id>/edit`）没有独立标题，按路径逐段回退到最近父级，
 * 免得页头空着、让人不知道自己在哪一层。
 */
const titleOf = (pathname: string): string =>
  EXTRA_TITLES[pathname] ?? menuTitleOf(pathname)

export type AppHeaderProps = Partial<{} & ComponentProps<'div'>>

export const AppHeader = ({ className, ...props }: AppHeaderProps) => {
  const pathname = usePathname()
  const title = titleOf(pathname)

  return (
    <div
      className={cn(
        'flex h-12 shrink-0 items-center justify-between gap-3 bg-background/85 px-4 backdrop-blur-sm',
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
