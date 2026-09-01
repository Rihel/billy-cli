"use client"

import type { ReactNode } from "react"

import { cn } from "#lib/utils"
import { Button } from "#components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "#components/ui/tooltip"
import { RefreshCwIcon } from "lucide-react"

export type RefreshButtonProps = {
  label?: ReactNode
  tooltip?: ReactNode
  loading?: boolean
  disabled?: boolean
  className?: string
  onClick?: () => void
  "aria-label"?: string
}

/** 刷新按钮（带 tooltip，loading 时图标旋转） */
export function RefreshButton({
  label,
  tooltip = "刷新",
  loading,
  disabled,
  className,
  onClick,
  ...rest
}: RefreshButtonProps) {
  const button = (
    <Button
      variant="outline"
      size={label ? "default" : "icon"}
      aria-label={rest["aria-label"] ?? "刷新"}
      disabled={disabled || loading}
      onClick={onClick}
      className={className}
    >
      <RefreshCwIcon className={cn(loading && "animate-spin")} />
      {label}
    </Button>
  )

  if (!tooltip) return button

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
