"use client"

import type { ReactNode } from "react"

import { cn } from "#lib/utils"
import { useRect } from "#hooks/use-rect"

export type PageToolbarProps = {
  title?: ReactNode
  extra?: ReactNode
  children?: ReactNode
  className?: string
}

/** 页面工具条：标题 + 右侧操作区 + 下方搜索/筛选区（窄屏自动纵向排列） */
export function PageToolbar({
  title,
  extra,
  children,
  className,
}: PageToolbarProps) {
  const { ref, rect } = useRect()
  const compact = rect.width > 0 && rect.width < 640

  return (
    <div ref={ref} className={cn(className)}>
      <div
        className={cn(
          "flex gap-4",
          compact ? "flex-col items-stretch" : "items-center justify-between",
        )}
      >
        {title ? <div className="text-2xl font-semibold tracking-tight">{title}</div> : null}
        {extra ? (
          <div className="flex flex-wrap items-center gap-2">{extra}</div>
        ) : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  )
}
