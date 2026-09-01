"use client"

import type { CSSProperties, HTMLAttributes, ReactNode } from "react"

import { cn } from "#lib/utils"

export type GroupProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title?: ReactNode
  headerExtra?: ReactNode
  mark?: boolean
  bordered?: boolean
  headerClassName?: string
  headerExtraClassName?: string
  headerStyle?: CSSProperties
  contentClassName?: string
}

/** 分组卡片：标题（可选左侧色条标记）+ 右侧额外操作 + 内容区 */
export function Group({
  title,
  headerExtra,
  mark = true,
  bordered = false,
  className,
  headerClassName,
  headerExtraClassName,
  headerStyle,
  contentClassName,
  children,
  ...props
}: GroupProps) {
  return (
    <section
      {...props}
      className={cn(
        "w-full",
        bordered && "border border-border p-4",
        className,
      )}
    >
      {title || headerExtra ? (
        <header
          className={cn(
            "mb-4 flex min-h-8 items-center justify-between gap-4",
            headerClassName,
          )}
          style={headerStyle}
        >
          <div
            className={cn(
              "text-base font-medium",
              mark && "border-l-2 border-l-primary pl-3 leading-5",
            )}
          >
            {title}
          </div>
          {headerExtra ? (
            <div className={cn("flex items-center gap-2", headerExtraClassName)}>
              {headerExtra}
            </div>
          ) : null}
        </header>
      ) : null}
      <div className={contentClassName}>{children}</div>
    </section>
  )
}
