import { afterEach, describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../src/foundation/scheduler/scheduler.js'
import { SchedulerError } from '../src/foundation/errors/infrastructure-errors.js'
import { testLogger } from './helpers/logger.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Scheduler', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('scheduleTimeout 延迟触发一次后自动清理', async () => {
    const scheduler = new Scheduler(testLogger())
    const handler = vi.fn()
    scheduler.scheduleTimeout('t1', 20, handler)
    await sleep(50)
    expect(handler).toHaveBeenCalledTimes(1)
    // 已自动清理，再次等更久也不会触发
    await sleep(30)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('scheduleInterval 按固定间隔周期触发', async () => {
    const scheduler = new Scheduler(testLogger())
    const handler = vi.fn()
    scheduler.scheduleInterval('i1', 15, handler)
    await sleep(55)
    scheduler.stop('i1')
    // 15ms 间隔，55ms 内应触发约 3 次
    expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2)
    const count = handler.mock.calls.length
    await sleep(30)
    expect(handler.mock.calls.length).toBe(count)
  })

  it('scheduleCron 按秒级表达式周期触发', async () => {
    const scheduler = new Scheduler(testLogger())
    const handler = vi.fn()
    scheduler.scheduleCron('c1', '* * * * * *', handler)
    await sleep(1300)
    scheduler.stop('c1')
    expect(handler.mock.calls.length).toBeGreaterThanOrEqual(1)
    const count = handler.mock.calls.length
    await sleep(1100)
    expect(handler.mock.calls.length).toBe(count)
  })

  it('重复注册同名任务抛 SchedulerError', () => {
    const scheduler = new Scheduler(testLogger())
    scheduler.scheduleTimeout('dup', 1000, () => {})
    expect(() => scheduler.scheduleTimeout('dup', 1000, () => {})).toThrow(SchedulerError)
  })

  it('handler 抛异常被记录并吞掉，不中断调度循环', async () => {
    const scheduler = new Scheduler(testLogger())
    const error = new Error('boom')
    const handler = vi.fn(async () => {
      throw error
    })
    scheduler.scheduleInterval('err', 15, handler)
    await sleep(50)
    scheduler.stop('err')
    // 异常不应向外抛出，调度循环仍继续（多次调用）
    expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('stopAll 后所有任务不再触发', async () => {
    const scheduler = new Scheduler(testLogger())
    const handler = vi.fn()
    scheduler.scheduleTimeout('x1', 20, handler)
    scheduler.scheduleInterval('x2', 15, handler)
    scheduler.stopAll()
    await sleep(60)
    expect(handler).not.toHaveBeenCalled()
  })

  it('非法间隔时长抛 SchedulerError', () => {
    const scheduler = new Scheduler(testLogger())
    expect(() => scheduler.scheduleInterval('bad', -1, () => {})).toThrow(SchedulerError)
    expect(() => scheduler.scheduleTimeout('bad2', NaN, () => {})).toThrow(SchedulerError)
  })
})
