'use client'

import type { ReactNode } from 'react'

export type RouteNotFoundProps = {
  /**
   * 动作区（如「回到首页」按钮）。
   * 由 app 传入元素而不是本组件 import `next/link` —— 组件库不依赖 Next，
   * 回哪个首页也本来就是各 app 自己的事（前台回首页、后台回工作台）。
   */
  action?: ReactNode
  title?: string
  description?: string
}

/** 路由级 404 兜底的版式（`app/not-found.tsx` 用它，文件本身只留一行壳） */
export function RouteNotFound({
  action,
  title = '404',
  description = '抱歉，你访问的页面不存在。',
}: RouteNotFoundProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="font-mono text-6xl font-semibold tracking-tight text-foreground">
          {title}
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
        {action}
      </div>
    </div>
  )
}
