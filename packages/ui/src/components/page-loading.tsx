"use client"

import type { ReactNode } from "react"

import { cn } from "#lib/utils"
import { Spinner } from "#components/ui/spinner"

export type PageLoadingProps = {
  tip?: ReactNode
  fullscreen?: boolean
  className?: string
}

/** 页面加载占位：居中 spinner + 可选提示文案 */
export function PageLoading({
  tip,
  fullscreen = false,
  className,
}: PageLoadingProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2",
        fullscreen ? "min-h-screen" : "min-h-64",
        className,
      )}
    >
      <Spinner className="size-8" />
      {tip ? <div className="text-sm text-muted-foreground">{tip}</div> : null}
    </div>
  )
}
