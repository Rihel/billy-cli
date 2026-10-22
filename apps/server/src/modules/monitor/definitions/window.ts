import type { MetricWindow } from './metric.types.js'

/** 上海时区固定 UTC+8（当前部署业务日按 Asia/Shanghai） */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

/** 按评估周期对齐的窗口：半开区间 [start, end) */
export function alignedWindow(intervalSeconds: number, now: Date): MetricWindow {
  const intervalMs = intervalSeconds * 1000
  const endMs = Math.floor(now.getTime() / intervalMs) * intervalMs
  const start = new Date(endMs - intervalMs)
  const end = new Date(endMs)
  return { key: start.toISOString(), start, end }
}

/** 按天窗口（Asia/Shanghai），key 用 YYYY-MM-DD */
export function dayWindow(now: Date): MetricWindow {
  const shifted = new Date(now.getTime() + SHANGHAI_OFFSET_MS)
  const startUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  )
  const start = new Date(startUtc - SHANGHAI_OFFSET_MS)
  return {
    key: shifted.toISOString().slice(0, 10),
    start,
    end: now,
  }
}

/** 由 Telemetry 已结束窗口构造 MetricWindow */
export function windowFromTelemetry(windowStartAt: number, windowEndAt: number): MetricWindow {
  const start = new Date(windowStartAt)
  return { key: start.toISOString(), start, end: new Date(windowEndAt) }
}

/** 毫秒数转成窗口 key（按天用日期，其它用起点 ISO） */
export function windowKeyOf(start: Date, intervalSeconds: number): string {
  return intervalSeconds >= 86_400
    ? start.toISOString().slice(0, 10)
    : start.toISOString()
}
