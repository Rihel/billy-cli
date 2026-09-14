import { afterEach, describe, expect, it, vi } from 'vitest'
import { TimeWheel, TimeWheelType } from '../src/foundation/time-wheel/time-wheel.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 每格 10ms、20 格（覆盖 200ms）的小时间轮，便于快速验证 */
const createWheel = () => new TimeWheel(10, 20)

describe('TimeWheel', () => {
  let wheel: TimeWheel | undefined

  afterEach(() => {
    wheel?.stop()
    wheel = undefined
  })

  it('构造参数非法时抛错', () => {
    expect(() => new TimeWheel(0, 10)).toThrow(/tickDuration/)
    expect(() => new TimeWheel(10, 0)).toThrow(/wheelsCount/)
  })

  it('once 任务到点触发一次后自动移除', async () => {
    wheel = createWheel()
    const handler = vi.fn()
    wheel.addJob({
      id: 'once',
      type: TimeWheelType.Once,
      timeout: 30,
      exec: handler,
    })
    wheel.start()

    await sleep(150)
    expect(handler).toHaveBeenCalledTimes(1)

    // 已自动移除，再等也不会重复触发
    await sleep(80)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('interval 任务按间隔周期触发', async () => {
    wheel = createWheel()
    const handler = vi.fn()
    wheel.addJob({
      id: 'interval',
      type: TimeWheelType.Interval,
      interval: 40,
      exec: handler,
    })
    wheel.start()

    await sleep(210)
    // 40ms 间隔，210ms 内大约 4~5 次，只断言次数区间避免 CI 抖动
    const count = handler.mock.calls.length
    expect(count).toBeGreaterThanOrEqual(3)
    expect(count).toBeLessThanOrEqual(6)
  })

  it('removeJob 后不再触发', async () => {
    wheel = createWheel()
    const handler = vi.fn()
    wheel.addJob({
      id: 'removable',
      type: TimeWheelType.Interval,
      interval: 30,
      exec: handler,
    })
    wheel.start()

    await sleep(80)
    const countAfterRemove = handler.mock.calls.length
    expect(countAfterRemove).toBeGreaterThan(0)

    wheel.removeJob('removable')
    await sleep(80)
    expect(handler.mock.calls.length).toBe(countAfterRemove)
  })

  it('stop 后 tick 循环停止', async () => {
    wheel = createWheel()
    const handler = vi.fn()
    wheel.addJob({
      id: 'stopped',
      type: TimeWheelType.Interval,
      interval: 20,
      exec: handler,
    })
    wheel.start()

    await sleep(60)
    expect(handler.mock.calls.length).toBeGreaterThan(0)

    wheel.stop()
    const countAfterStop = handler.mock.calls.length
    await sleep(60)
    expect(handler.mock.calls.length).toBe(countAfterStop)
  })

  it('start 幂等：重复调用不会叠加 tick 循环', async () => {
    wheel = createWheel()
    const handler = vi.fn()
    wheel.addJob({
      id: 'idempotent',
      type: TimeWheelType.Once,
      timeout: 40,
      exec: handler,
    })
    wheel.start()
    wheel.start()

    await sleep(140)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('任务异常交给 onError，不打断 tick 循环', async () => {
    wheel = createWheel()
    const onError = vi.fn()
    const okHandler = vi.fn()

    wheel.addJob({
      id: 'throwing',
      type: TimeWheelType.Interval,
      interval: 30,
      exec: () => {
        throw new Error('boom')
      },
      onError,
    })
    wheel.addJob({
      id: 'healthy',
      type: TimeWheelType.Interval,
      interval: 30,
      exec: okHandler,
    })
    wheel.start()

    await sleep(140)
    expect(onError).toHaveBeenCalled()
    // 同轮其它任务不受影响，且循环持续
    expect(okHandler.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('重复 job id 抛错', () => {
    wheel = createWheel()
    wheel.addJob({ id: 'dup', type: TimeWheelType.Once, timeout: 10, exec: vi.fn() })
    expect(() =>
      wheel!.addJob({ id: 'dup', type: TimeWheelType.Once, timeout: 10, exec: vi.fn() }),
    ).toThrow(/already exists/)
  })

  it('interval 小于刻度时长抛错', () => {
    wheel = createWheel()
    expect(() =>
      wheel!.addJob({
        id: 'too-fast',
        type: TimeWheelType.Interval,
        interval: 5,
        exec: vi.fn(),
      }),
    ).toThrow(/tickDuration/)
  })

  it('cron 任务可登记（表达式推算走 croner）', () => {
    wheel = createWheel()
    expect(() =>
      wheel!.addJob({
        id: 'cron',
        type: TimeWheelType.Cron,
        cron: '0 0 0 1 1 *',
        exec: vi.fn(),
      }),
    ).not.toThrow()
    expect(() => wheel!.removeJob('cron')).not.toThrow()
  })

  it('cron 任务缺少表达式时抛错', () => {
    wheel = createWheel()
    expect(() =>
      wheel!.addJob({ id: 'no-cron', type: TimeWheelType.Cron, exec: vi.fn() }),
    ).toThrow(/cron/)
  })
})
