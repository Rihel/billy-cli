'use client'

import type { CSSProperties, ReactNode } from 'react'

import { cn } from '#lib/utils'
import { Badge } from '#components/ui/badge'

/**
 * 预设色名 → 样式类映射。
 *
 * **只有四类语义色**（success / error / warning / processing）与中性 default：
 * 全部消费本包 `globals.css` 的语义 token（`--success` / `--destructive` / `--warning` / `--info`），
 * 极淡底 + 语义前景，深浅色自动适配。
 *
 * 历史色名（blue / cyan / green / red / gold / orange / purple / magenta / geekblue / volcano）
 * 保留为**别名**，统一折算到语义色或品牌色 —— 调用方不用改，界面不再出现 antd 装饰色。
 * 新代码请直接用语义色名。
 */
const PRESET_COLORS: Record<string, string> = {
  default: 'bg-muted/40 text-muted-foreground',
  success: 'bg-success/10 text-success',
  error: 'bg-destructive/10 text-destructive',
  warning: 'bg-warning/10 text-warning',
  processing: 'bg-info/10 text-info',
  // ---- 历史色名别名：收敛到语义色 / 品牌色 ----
  blue: 'bg-info/10 text-info',
  cyan: 'bg-info/10 text-info',
  green: 'bg-success/10 text-success',
  red: 'bg-destructive/10 text-destructive',
  gold: 'bg-warning/10 text-warning',
  orange: 'bg-warning/10 text-warning',
  volcano: 'bg-warning/10 text-warning',
  purple: 'bg-brand/10 text-brand',
  magenta: 'bg-brand/10 text-brand',
  geekblue: 'bg-brand/10 text-brand',
}

export type TagProps = {
  /** 常见预设色名（blue / green / red ...）或任意 CSS 颜色值（#hex） */
  color?: string
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

/** 标签（Badge 封装，支持预设色名或任意 CSS 颜色） */
export function Tag({ color = 'default', children, className, style }: TagProps) {
  const preset = PRESET_COLORS[color]
  const hex = color.startsWith('#')
  return (
    <Badge
      className={cn(hex ? undefined : (preset ?? PRESET_COLORS.default), className)}
      style={hex ? { backgroundColor: color, color: '#fff', ...style } : style}
    >
      {children}
    </Badge>
  )
}
