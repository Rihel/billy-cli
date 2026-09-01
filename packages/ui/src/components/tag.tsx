"use client"

import type { CSSProperties, ReactNode } from "react"

import { cn } from "#lib/utils"
import { Badge } from "#components/ui/badge"

/** 常见预设色名 → tailwind 语义类映射 */
const PRESET_COLORS: Record<string, string> = {
  default: "bg-muted text-muted-foreground",
  success: "bg-emerald-100 text-emerald-700",
  error: "bg-red-100 text-red-700",
  warning: "bg-amber-100 text-amber-700",
  processing: "bg-blue-100 text-blue-700",
  blue: "bg-blue-100 text-blue-700",
  cyan: "bg-cyan-100 text-cyan-700",
  green: "bg-emerald-100 text-emerald-700",
  red: "bg-red-100 text-red-700",
  gold: "bg-amber-100 text-amber-700",
  orange: "bg-orange-100 text-orange-700",
  purple: "bg-purple-100 text-purple-700",
  magenta: "bg-pink-100 text-pink-700",
  geekblue: "bg-indigo-100 text-indigo-700",
  volcano: "bg-orange-100 text-orange-700",
}

export type TagProps = {
  /** 常见预设色名（blue / green / red ...）或任意 CSS 颜色值（#hex） */
  color?: string
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

/** 标签（Badge 封装，支持预设色名或任意 CSS 颜色） */
export function Tag({ color = "default", children, className, style }: TagProps) {
  const preset = PRESET_COLORS[color]
  const hex = color.startsWith("#")
  return (
    <Badge
      className={cn(hex ? undefined : preset ?? PRESET_COLORS.default, className)}
      style={hex ? { backgroundColor: color, color: "#fff", ...style } : style}
    >
      {children}
    </Badge>
  )
}
