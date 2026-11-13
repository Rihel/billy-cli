'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@repo/ui'

/**
 * 数字滚动：从 0 / 上一次的值缓动到目标值。
 * 不引动画库；prefers-reduced-motion 时直接显示终值。
 */
export function AnimatedNumber({
  value,
  format = (next) => String(next),
  durationMs = 700,
  className,
}: {
  value: number | null | undefined
  format?: (value: number) => string
  durationMs?: number
  className?: string
}) {
  const target = value ?? 0
  const [display, setDisplay] = useState(0)
  const fromRef = useRef(0)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    if (value == null) return
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setDisplay(target)
      fromRef.current = target
      return
    }
    const from = fromRef.current
    const startedAt = performance.now()
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs)
      const eased = 1 - Math.pow(1 - progress, 3)
      setDisplay(from + (target - from) * eased)
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = target
      }
    }
    frameRef.current = requestAnimationFrame(tick)
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [durationMs, target, value])

  return (
    <span className={cn('tabular-nums', className)}>{value == null ? '-' : format(display)}</span>
  )
}
