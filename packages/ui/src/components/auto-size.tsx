"use client"

import type { CSSProperties, ReactNode } from "react"

import { cn } from "#lib/utils"
import { useRect } from "#hooks/use-rect"
import type { ElementRect, UseRectOptions } from "#hooks/use-rect"

export type AutoSizeProps = {
  /** 渲染函数：接收实时测量到的容器尺寸 */
  children: (rect: ElementRect) => ReactNode
  className?: string
  style?: CSSProperties
  rectOptions?: UseRectOptions
}

/** 自适应容器：用 useRect 实时测量自身尺寸并交给 children 渲染（如虚拟列表高度） */
export function AutoSize({
  children,
  className,
  style,
  rectOptions,
}: AutoSizeProps) {
  const { ref, rect } = useRect(rectOptions)

  return (
    <div ref={ref} className={cn("h-full w-full", className)} style={style}>
      {children(rect)}
    </div>
  )
}
