'use client'

import { AnimatedNumber } from '@/components/animated-number'
import { usageLineSegments, usageTooltip } from './format'

/**
 * 输入框右下角的**会话累计**统计：`N 轮 M 步，输入 X，输出 Y，缓存命中 Z%`。
 *
 * 数字走 {@link AnimatedNumber} **滚动到新值**：实时用量每步来一条（`data-step-usage`），
 * 收尾值（`data-run-usage`）往往紧跟最后一步、不到一秒就到达 —— 直接换数字会"啪"地跳，
 * 滚动既能表达"在涨"，也不会让两个几乎同时到达的值看起来像刷了两次。
 *
 * 分工：文案口径在 `format.ts` 的 `usageLineSegments`（纯函数、有单测），这里只管排版与动画；
 * 悬停是**精确值**（`usageTooltip`：累计一行 + 本轮一行，不做动画 —— 对账要看准）。
 */
export function UsageLine({
  usage,
  turn,
  current,
}: {
  /** 会话**累计**用量（行内显示的就是它） */
  usage: Record<string, unknown> | null
  /** 这是第几轮 */
  turn: number
  /** 本轮用量（只进悬停；拿不到就没有那一段） */
  current: Record<string, unknown> | null
}) {
  const segments = usageLineSegments(usage, turn)
  if (!segments) return null
  return (
    <span
      className="truncate text-xs text-muted-foreground"
      title={usageTooltip(usage, turn, current)}
    >
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <AnimatedNumber
            key={index}
            value={segment.value}
            format={segment.format}
            durationMs={600}
          />
        ),
      )}
    </span>
  )
}
