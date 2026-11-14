'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@repo/ui'

/**
 * 数字滚动：从 0 / 上一次的值缓动到目标值。
 * 不引动画库；prefers-reduced-motion 时直接显示终值。
 *
 * **目标在动画途中又变了**（右下角用量每步来一次，收尾值往往紧跟最后一步 <1s 到达）：
 * 从**当前屏幕上显示的值**接着滚，而不是从"上一次滚完的值"重来 ——
 * 否则会先往回跳一下再重新爬（用户看到的是数字闪一下）。
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
  /** 当前**屏幕上**的值（逐帧更新）：目标变化时从这里接着滚，避免往回跳 */
  const displayRef = useRef(0)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    if (value == null) {
      // 没有值就显示 `-`（调用方用它表示"没上报"）；下次有值了从 0 重新滚
      displayRef.current = 0
      return
    }
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      displayRef.current = target
      setDisplay(target)
      return
    }
    const from = displayRef.current
    const startedAt = performance.now()
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs)
      const eased = 1 - Math.pow(1 - progress, 3)
      const next = from + (target - from) * eased
      displayRef.current = next
      setDisplay(next)
      if (progress < 1) frameRef.current = requestAnimationFrame(tick)
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
