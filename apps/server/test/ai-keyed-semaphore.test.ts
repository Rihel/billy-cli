import { describe, expect, it } from 'vitest'
import { KeyedSemaphore } from '../src/modules/ai/runtime/keyed-semaphore.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('KeyedSemaphore', () => {
  it('同一 key 最多同时 3 个，其余排队；峰值不超过上限', async () => {
    const sem = new KeyedSemaphore(3)
    let running = 0
    let peak = 0
    const task = async (): Promise<void> => {
      await sem.acquire('run')
      running += 1
      peak = Math.max(peak, running)
      await sleep(5)
      running -= 1
      sem.release('run')
    }
    await Promise.all(Array.from({ length: 7 }, () => task()))
    expect(peak).toBe(3)
    expect(sem.activeOf('run')).toBe(0)
  })

  it('不同 key 互不影响', async () => {
    const sem = new KeyedSemaphore(1)
    await sem.acquire('a')
    await sem.acquire('b')
    expect(sem.activeOf('a')).toBe(1)
    expect(sem.activeOf('b')).toBe(1)
    sem.release('a')
    sem.release('b')
    expect(sem.activeOf('a')).toBe(0)
    expect(sem.activeOf('b')).toBe(0)
  })

  it('释放按先来后到转交，不超限也不插队', async () => {
    const sem = new KeyedSemaphore(1)
    const order: string[] = []
    await sem.acquire('k')
    const second = sem.acquire('k').then(() => order.push('second'))
    const third = sem.acquire('k').then(() => order.push('third'))
    expect(order).toEqual([])
    sem.release('k')
    await second
    expect(order).toEqual(['second'])
    sem.release('k')
    await third
    expect(order).toEqual(['second', 'third'])
    sem.release('k')
    expect(sem.activeOf('k')).toBe(0)
  })

  it('limit 必须是正整数', () => {
    expect(() => new KeyedSemaphore(0)).toThrowError(/正整数/)
    expect(() => new KeyedSemaphore(1.5)).toThrowError(/正整数/)
  })
})
