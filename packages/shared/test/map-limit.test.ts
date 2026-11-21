import { describe, expect, it } from 'vitest'
import { mapLimit } from '../src/utils/async.utils'

/**
 * `mapLimit`：逐项并发 + 保序。
 *
 * 用来替代"for 里 await"的串行下载（技能导入一次要拉几百个文件）：
 * 并发度上去之后耗时从「N × 单次往返」降到「N / 并发 × 单次往返」。
 */
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('mapLimit', () => {
  it('结果与入参顺序一致（即使完成顺序不同）', async () => {
    const items = [30, 10, 20]
    const result = await mapLimit(items, 3, async (ms, index) => {
      await delay(ms)
      return `${index}:${ms}`
    })

    expect(result).toEqual(['0:30', '1:10', '2:20'])
  })

  it('并发度受上限约束（同时最多 N 个在跑）', async () => {
    let active = 0
    let peak = 0
    await mapLimit(
      Array.from({ length: 12 }, (_, i) => i),
      4,
      async () => {
        active += 1
        peak = Math.max(peak, active)
        await delay(5)
        active -= 1
      },
    )

    expect(peak).toBeLessThanOrEqual(4)
  })

  it('空数组直接返回空', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })

  it('任一任务失败 → 整批 reject（不静默吞掉）', async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (value) => {
        if (value === 2) throw new Error('boom')
        return value
      }),
    ).rejects.toThrow('boom')
  })

  it('并发度非法 → RangeError', async () => {
    await expect(mapLimit([1], 0, async () => 1)).rejects.toThrow(RangeError)
  })
})
