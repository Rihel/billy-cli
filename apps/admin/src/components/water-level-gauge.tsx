'use client'

import { useId } from 'react'
import { cn } from '@repo/ui'

/**
 * 水位图：圆形水槽 + 液面波动。
 * 只表达「当前值 / 上限」和阈值位置；颜色随越线程度在 primary / warning / destructive 间切换。
 */
export function WaterLevelGauge({
  label,
  value,
  max,
  threshold,
  format,
  unit,
  className,
}: {
  label: string
  value: number | null | undefined
  max: number
  threshold: number
  format: (value: number) => string
  unit?: string
  className?: string
}) {
  const uid = useId().replace(/:/g, '')
  const clipId = `water-${uid}`
  const fillId = `water-fill-${uid}`
  const ratio = value == null || max <= 0 ? 0 : Math.max(0, Math.min(1, value / max))
  const thresholdRatio = max <= 0 ? 0 : Math.max(0, Math.min(1, threshold / max))
  const waterY = 100 - ratio * 88 - 6
  const thresholdY = 100 - thresholdRatio * 88 - 6
  const color =
    value == null
      ? 'var(--muted-foreground)'
      : value >= threshold
        ? 'var(--destructive)'
        : value >= threshold * 0.75
          ? 'var(--warning)'
          : 'var(--primary)'

  return (
    <div className={cn('flex min-w-0 flex-col items-center gap-2', className)}>
      <div className="relative size-20 shrink-0">
        <svg viewBox="0 0 100 100" className="size-full" aria-hidden="true">
          <defs>
            <clipPath id={clipId}>
              <circle cx="50" cy="50" r="44" />
            </clipPath>
            {/* 液面自带渐变：单一平涂色在浅色底上会像一块实心圆，渐变让水位读起来像液体 */}
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.52} />
              <stop offset="100%" stopColor={color} stopOpacity={0.28} />
            </linearGradient>
          </defs>
          <circle cx="50" cy="50" r="44" fill="var(--surface-2)" />
          <circle
            cx="50"
            cy="50"
            r="44"
            fill="none"
            stroke="var(--border)"
            strokeWidth="1"
          />
          <g clipPath={`url(#${clipId})`}>
            <rect
              x="0"
              y={waterY + 6}
              width="100"
              height={Math.max(0, 100 - waterY - 6)}
              fill={`url(#${fillId})`}
            />
            {ratio > 0 ? (
              <g transform={`translate(0 ${waterY})`}>
                <g className="water-wave">
                  <path
                    d="M0 6 Q 12.5 0 25 6 T 50 6 T 75 6 T 100 6 T 125 6 T 150 6 T 175 6 T 200 6 V 18 H0 Z"
                    fill={`url(#${fillId})`}
                  />
                </g>
              </g>
            ) : null}
            <line
              x1="10"
              x2="90"
              y1={thresholdY}
              y2={thresholdY}
              stroke="var(--foreground)"
              strokeOpacity="0.38"
              strokeDasharray="2 3"
              strokeWidth="1"
            />
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pt-1">
          <span className="font-heading text-base font-medium tabular-nums tracking-tight">
            {value == null ? '-' : format(value)}
          </span>
          {unit ? <span className="text-[10px] text-muted-foreground">{unit}</span> : null}
        </div>
      </div>
      <div className="w-full text-center">
        <div className="truncate text-[11px] text-muted-foreground" title={label}>
          {label}
        </div>
        <div className="mt-0.5 text-[10px] tabular-nums text-muted-foreground/70">
          阈值 {format(threshold)}{unit ?? ''}
        </div>
      </div>
    </div>
  )
}
