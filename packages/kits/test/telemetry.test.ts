import { describe, expect, it } from 'vitest'
import { Telemetry } from '../src/telemetry/telemetry.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const createTelemetry = (windowSeconds: number): Telemetry =>
  new Telemetry(windowSeconds)

describe('Telemetry（埋点 + 窗口聚合）', () => {
  it('Counter：incr 累计，snapshot 返回窗口计数', () => {
    const telemetry = createTelemetry(60)
    telemetry.incr('request.count')
    telemetry.incr('request.count', 4)
    telemetry.incr('request.error')

    const snapshot = telemetry.snapshot()
    expect(snapshot.counters['request.count']).toBe(5)
    expect(snapshot.counters['request.error']).toBe(1)
  })

  it('Gauge：当前值', () => {
    const telemetry = createTelemetry(60)
    telemetry.gauge('inventory.available', 5)
    expect(telemetry.snapshot().gauges['inventory.available']).toBe(5)
  })

  it('Histogram：分位数近似（桶上界，P50 / P95 / P99）', () => {
    const telemetry = createTelemetry(60)
    // 100 个样本：50 个 ≤100ms（桶上界 128），50 个 =400ms（桶上界 512）
    for (let i = 0; i < 50; i++) telemetry.histogram('request.duration', 100)
    for (let i = 0; i < 50; i++) telemetry.histogram('request.duration', 400)

    const histogram = telemetry.snapshot().histograms['request.duration']
    expect(histogram.count).toBe(100)
    expect(histogram.sum).toBe(25000)
    // 对数桶近似：P50 落在 100 所在桶（上界 128），P95/P99 落在 400 所在桶（上界 512）
    expect(histogram.quantile(0.5)).toBe(128)
    expect(histogram.quantile(0.95)).toBe(512)
    expect(histogram.quantile(0.99)).toBe(512)
  })

  it('错误率 / QPS 可由计数与窗口推导', () => {
    const telemetry = createTelemetry(60)
    telemetry.incr('request.count', 200)
    telemetry.incr('request.error', 12)
    const snapshot = telemetry.snapshot()
    const errorRate = snapshot.counters['request.error'] / snapshot.counters['request.count']
    const qps = snapshot.counters['request.count'] / snapshot.windowSeconds
    expect(errorRate).toBeCloseTo(0.06)
    expect(qps).toBeCloseTo(200 / 60)
  })

  it('窗口滚动：超时后当前计数归档为前一窗口（surge 环比基线），当前重置', async () => {
    const telemetry = createTelemetry(0.05) // 50ms 窗口
    telemetry.incr('request.count', 100)
    await sleep(80)
    telemetry.incr('request.count', 300)

    const snapshot = telemetry.snapshot()
    expect(snapshot.counters['request.count']).toBe(300) // 当前窗口
    expect(snapshot.previousCounters['request.count']).toBe(100) // 前一窗口（基线）
    expect(snapshot.previousWindowStartAt).not.toBeNull()
  })

  it('首个窗口无基线（previousWindowStartAt 为 null）', () => {
    const telemetry = createTelemetry(60)
    const snapshot = telemetry.snapshot()
    expect(snapshot.previousWindowStartAt).toBeNull()
    expect(snapshot.previousCounters).toEqual({})
  })
})
