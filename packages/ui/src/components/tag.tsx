"use client"

import type { CSSProperties, ReactNode } from "react"

import { cn } from "#lib/utils"
import { Badge } from "#components/ui/badge"

/**
 * 常见预设色名 → 样式类映射。
 *
 * - **语义四色**（success / error / warning / processing）消费本包 `globals.css` 的语义 token
 *   （`--success` / `--destructive` / `--warning` / `--info`），底色与边框用透明度派生 ——
 *   比 antd 的 color-1/3/7 三件套更少 token，且深浅色模式自动适配；
 * - 其余色名（blue / cyan / green / gold / orange / purple / magenta / geekblue / volcano）是
 *   历史遗留的装饰色（部分沿用 antd 命名，正被页面使用），暂用 Tailwind 调色板，
 *   待独立一轮收敛（记档于 docs/design/design-system.md 的已知缺口）。
 *
 * 现代克制风格：极淡底 + 细边框 + 深色文字（非 antd 的强彩 100 底块）。
 */
const PRESET_COLORS: Record<string, string> = {
  default:
    "border border-border bg-muted/40 text-muted-foreground",
  success:
    "border border-success/30 bg-success/10 text-success",
  error:
    "border border-destructive/30 bg-destructive/10 text-destructive",
  warning:
    "border border-warning/30 bg-warning/10 text-warning",
  processing:
    "border border-info/30 bg-info/10 text-info",
  blue: "border border-indigo-200 bg-indigo-50 text-indigo-700",
  cyan: "border border-cyan-200 bg-cyan-50 text-cyan-700",
  green: "border border-emerald-200 bg-emerald-50 text-emerald-700",
  red: "border border-red-200 bg-red-50 text-red-700",
  gold: "border border-amber-200 bg-amber-50 text-amber-700",
  orange: "border border-orange-200 bg-orange-50 text-orange-700",
  purple: "border border-purple-200 bg-purple-50 text-purple-700",
  magenta: "border border-pink-200 bg-pink-50 text-pink-700",
  geekblue:
    "border border-indigo-200 bg-indigo-50 text-indigo-700",
  volcano: "border border-orange-200 bg-orange-50 text-orange-700",
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
