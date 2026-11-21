import { describe, expect, it } from 'vitest'
import { KeyedMutex } from '../src/workspace/keyed-mutex.js'

/**
 * 执行面按 key 串行的闸门：同一个工作区的 bash、同一条路径的写都靠它。
 *
 * 语义（不能退化）：同 key 串行、不同 key 并行、任务抛错不堵后面的队列。
 */

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('KeyedMutex', () => {
  it('同 key 的第二个任务等第一个结束（不会看到中间态）', async () => {
    const mutex = new KeyedMutex()
    const order: string[] = []

    await Promise.all([
      mutex.run('ws:a', async () => {
        order.push('first:start')
        await tick(20)
        order.push('first:end')
      }),
      mutex.run('ws:a', async () => {
        order.push('second:start')
      }),
    ])

    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
    expect(mutex.size()).toBe(0)
  })

  it('不同 key 并行执行（工作区之间不互相拖）', async () => {
    const mutex = new KeyedMutex()
    let running = 0
    let max = 0
    const task = async (): Promise<void> => {
      running += 1
      max = Math.max(max, running)
      await tick(20)
      running -= 1
    }

    await Promise.all([mutex.run('ws:a', task), mutex.run('ws:b', task)])

    expect(max).toBe(2)
    expect(mutex.size()).toBe(0)
  })

  it('任务抛错会传出去，且后面的任务照常执行（不会永久堵死）', async () => {
    const mutex = new KeyedMutex()

    await expect(
      mutex.run('ws:a', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await expect(mutex.run('ws:a', async () => 'ok')).resolves.toBe('ok')
    expect(mutex.size()).toBe(0)
  })
})
