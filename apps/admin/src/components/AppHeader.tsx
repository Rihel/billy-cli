'use client'

import { usePathname } from 'next/navigation'
import { cn, SidebarTrigger } from '@repo/ui'
import { ComponentProps } from 'react'
import { menuTitleOf } from './AppMenu'

/** 菜单之外的独立页面（个人中心在顶栏账号菜单里） */
const EXTRA_TITLES: Record<string, string> = {
  '/main/user-center': '个人中心',
}

/**
 * 取当前页标题：标题来源是**侧栏菜单本身**（`menuTitleOf`），菜单之外的页面查 `EXTRA_TITLES`。
 *
 * 详情页（`/main/xxx/<id>` / `/main/tools/<id>/edit`）没有独立标题，按路径逐段回退到最近父级，
 * 免得页头空着、让人不知道自己在哪一层。
 */
const titleOf = (pathname: string): string => EXTRA_TITLES[pathname] ?? menuTitleOf(pathname)

export type AppHeaderProps = Partial<{} & ComponentProps<'div'>>

/**
 * **分区页头**（只有管理台有）：折叠按钮 + 当前页标题。
 *
 * 顶层切换（会话 / 管理）、主题、账号都在全局顶栏（`AppTopBar`）里 —— 一条顶栏横贯两棵树，
 * 这里只回答"我现在在管理台的哪一页"，比顶栏矮一档（44px），不跟顶栏抢视觉重量。
 */
export const AppHeader = ({ className, ...props }: AppHeaderProps) => {
  const pathname = usePathname()
  const title = titleOf(pathname)

  return (
    <div className={cn('flex h-11 shrink-0 items-center gap-2.5 px-4', className)} {...props}>
      <SidebarTrigger className="-ml-1" />
      {title ? (
        <span className="font-heading truncate text-sm font-medium tracking-tight text-foreground">
          {title}
        </span>
      ) : null}
    </div>
  )
}
