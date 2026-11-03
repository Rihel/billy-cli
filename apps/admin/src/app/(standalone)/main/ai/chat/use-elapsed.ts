'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * 运行中计时：**按整秒跳动**，而不是每 500ms 刷一次。
 *
 * 为什么改（2026-11-03 用户反馈"500ms 刷一次怪怪的"）：工具卡原来是
 * `setInterval(..., 500)` 采样、再用 `durationText` 显示一位小数（`1.2s`）——
 * 采样粒度 0.5s、显示粒度 0.1s，于是数字按 0.5 一跳（0ms → 500ms → 1s → 1.5s），
 * 停下来那一瞬间还会比真实耗时少一截。计时器该是"秒表"，不是"每半秒抖一下"。
 *
 * 做法：显示整数秒，**按真实秒边界翻字**。
 * - 采样 250ms（跨秒最多晚 250ms 才翻字，肉眼无感）；
 * - `setSeconds` 值没变时 React 直接 bail out，所以**真正重渲染只有每秒一次**；
 * - 结束那一刻给最终整秒（向上取整，与 `Reasoning` 的收尾口径一致），此后不再跳动。
 *
 * 返回 `null` = 从未开始过（历史里没有耗时数据的卡不该显示 `0s`）。
 */

/** 采样间隔（毫秒）：显示粒度是整秒，250ms 足够跟上秒边界，又不会每帧都 setState */
const SAMPLE_MS = 250

/** 已经跑了多少整秒（纯函数，便于单测） */
export const elapsedSecondsOf = (startedAt: number, now: number): number =>
  Math.max(0, Math.floor((now - startedAt) / 1000))

/** 结束时的最终整秒：向上取整（0.2s 也算 1s，与 `Reasoning` 的 `Math.ceil` 同一口径） */
export const finalSecondsOf = (startedAt: number, now: number): number =>
  Math.max(1, Math.ceil((now - startedAt) / 1000))

export const useElapsedSeconds = (active: boolean): number | null => {
  const startedAtRef = useRef<number | null>(null)
  const [seconds, setSeconds] = useState<number | null>(null)

  useEffect(() => {
    if (active) {
      // 新的一次调用：从 0 开始
      const startedAt = Date.now()
      startedAtRef.current = startedAt
      setSeconds(0)
      const timer = setInterval(() => {
        setSeconds(elapsedSecondsOf(startedAt, Date.now()))
      }, SAMPLE_MS)
      return () => clearInterval(timer)
    }
    // 结束：冻结在最终整秒；从未开始过就保持 null（不显示 0s）
    if (startedAtRef.current === null) return
    setSeconds(finalSecondsOf(startedAtRef.current, Date.now()))
    startedAtRef.current = null
  }, [active])

  return seconds
}
