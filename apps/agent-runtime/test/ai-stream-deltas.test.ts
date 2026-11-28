import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DeltaCoalescer,
  coalesceKeyOf,
  isCoalescedDelta,
  mergeDelta,
} from '../src/modules/ai/runtime/stream/stream-deltas.js'

/**
 * 增量合并器（2026-11-22）。
 *
 * 钉住的是**帧数**与**顺序**两件事：
 * - 同一段内容的多个 token 只发一块（Redis 往返从 token 级降到 100ms 级）；
 * - 合并不能把两路内容混在一起（并行子 agent / 多个 part）；
 * - 冲块与"非增量块"必须严格按调用顺序（结束帧一定在正文之后）。
 */

const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

/** 让链上的微任务跑完（fake timers 下不推进时间也要给出一拍） */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
}

const makeCoalescer = (options: { intervalMs?: number; maxChars?: number } = {}) => {
  const batches: Array<Array<Record<string, unknown>>> = []
  let rev = 0
  const coalescer = new DeltaCoalescer({
    intervalMs: options.intervalMs ?? 100,
    maxChars: options.maxChars ?? 2_000,
    sink: async (chunks) => {
      batches.push(chunks)
      rev += 1
      return rev
    },
    onError: (error) => silentLogger.warn(error),
  })
  return { coalescer, batches }
}

describe('增量合并（纯函数）', () => {
  it('按类型与身份算合并键：文本按 part id、子 agent 按 runId+name+kind', () => {
    expect(coalesceKeyOf({ type: 'text-delta', id: 't1' })).toBe('text-delta:t1')
    expect(coalesceKeyOf({ type: 'text-delta' })).toBeNull()
    expect(
      coalesceKeyOf({
        type: 'data-sub-agent-delta',
        data: { runId: 'r1', name: '研究员', kind: 'text' },
      }),
    ).toBe('data-sub-agent-delta:r1:研究员:text')
  })

  it('只合并增量类型（状态块 / 边界块各是一条语义）', () => {
    expect(isCoalescedDelta({ type: 'text-delta', id: 't1' })).toBe(true)
    expect(isCoalescedDelta({ type: 'reasoning-delta', id: 'r1' })).toBe(true)
    expect(isCoalescedDelta({ type: 'data-sub-agent', id: 's1', data: { runId: 'r1' } })).toBe(
      false,
    )
    expect(isCoalescedDelta({ type: 'text-end', id: 't1' })).toBe(false)
    expect(isCoalescedDelta({ type: 'data-sub-agent-delta', data: { runId: 'r1' } })).toBe(false)
  })

  it('拼接正文时保留首块的其余字段（id / data 身份字段）', () => {
    const merged = mergeDelta(
      { type: 'text-delta', id: 't1', delta: '你' },
      { type: 'text-delta', id: 't1', delta: '好' },
    )
    expect(merged).toEqual({ type: 'text-delta', id: 't1', delta: '你好' })

    const sub = mergeDelta(
      { type: 'data-sub-agent-delta', data: { runId: 'r1', name: 'n', kind: 'text', text: 'A' } },
      { type: 'data-sub-agent-delta', data: { runId: 'r1', name: 'n', kind: 'text', text: 'B' } },
    )
    expect(sub.data).toEqual({ runId: 'r1', name: 'n', kind: 'text', text: 'AB' })
  })
})

describe('DeltaCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('100ms 到点把同 id 的多个 token 合成一块', async () => {
    const { coalescer, batches } = makeCoalescer()
    coalescer.push({ type: 'text-delta', id: 't1', delta: '你' })
    coalescer.push({ type: 'text-delta', id: 't1', delta: '好' })
    coalescer.push({ type: 'text-delta', id: 't1', delta: '呀' })
    expect(batches).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(100)

    expect(batches).toHaveLength(1)
    expect(batches[0]).toEqual([{ type: 'text-delta', id: 't1', delta: '你好呀' }])
    await coalescer.dispose()
  })

  it('不同 part / 不同子 agent 各攒一块，不混正文', async () => {
    const { coalescer, batches } = makeCoalescer()
    coalescer.push({ type: 'text-delta', id: 't1', delta: 'A' })
    coalescer.push({
      type: 'data-sub-agent-delta',
      data: { runId: 'r1', name: '甲', kind: 'text', text: 'X' },
    })
    coalescer.push({ type: 'text-delta', id: 't2', delta: 'B' })
    coalescer.push({
      type: 'data-sub-agent-delta',
      data: { runId: 'r2', name: '乙', kind: 'reasoning', text: 'Y' },
    })

    await vi.advanceTimersByTimeAsync(100)

    expect(batches).toHaveLength(1)
    const batch = batches[0] ?? []
    expect(batch).toHaveLength(4)
    // 顺序 = 各合并键首次出现的顺序
    expect(batch[0]).toMatchObject({ type: 'text-delta', id: 't1', delta: 'A' })
    expect(batch[1]).toMatchObject({ data: { runId: 'r1', text: 'X' } })
    expect(batch[2]).toMatchObject({ type: 'text-delta', id: 't2', delta: 'B' })
    expect(batch[3]).toMatchObject({ data: { runId: 'r2', text: 'Y' } })
    await coalescer.dispose()
  })

  it('累计字数超上限立刻冲，不等定时器（长帧不压着观感）', async () => {
    const { coalescer, batches } = makeCoalescer({ maxChars: 10 })
    coalescer.push({ type: 'text-delta', id: 't1', delta: '123456' })
    coalescer.push({ type: 'text-delta', id: 't1', delta: '789012' })

    await settle()

    expect(batches).toHaveLength(1)
    expect(batches[0]?.[0]?.delta).toBe('123456789012')
    await coalescer.dispose()
  })

  it('run 与 flush 走同一条链：非增量块一定排在攒着的正文之后', async () => {
    const order: string[] = []
    const coalescer = new DeltaCoalescer({
      intervalMs: 100,
      maxChars: 2_000,
      sink: async (chunks) => {
        order.push(`flush:${String(chunks[0]?.delta ?? '')}`)
        return 1
      },
    })

    coalescer.push({ type: 'text-delta', id: 't1', delta: '正文' })
    await coalescer.flush()
    await coalescer.run(async () => {
      order.push('direct')
    })

    expect(order).toEqual(['flush:正文', 'direct'])
    await coalescer.dispose()
  })

  it('dispose 冲掉残余并停表；之后到达的 push 被丢弃（那一轮已经收尾）', async () => {
    const { coalescer, batches } = makeCoalescer()
    coalescer.push({ type: 'text-delta', id: 't1', delta: '尾' })
    await coalescer.dispose()

    expect(batches).toHaveLength(1)
    expect(batches[0]?.[0]?.delta).toBe('尾')

    coalescer.push({ type: 'text-delta', id: 't1', delta: '迟到' })
    await vi.advanceTimersByTimeAsync(200)
    expect(batches).toHaveLength(1)
  })

  it('sink 失败不打断后续（记日志后链继续走）', async () => {
    let calls = 0
    const onError = vi.fn()
    const coalescer = new DeltaCoalescer({
      intervalMs: 100,
      maxChars: 2_000,
      sink: async () => {
        calls += 1
        if (calls === 1) throw new Error('redis 抖动')
        return calls
      },
      onError,
    })

    coalescer.push({ type: 'text-delta', id: 't1', delta: '一' })
    await coalescer.flush()
    expect(onError).toHaveBeenCalledTimes(1)

    coalescer.push({ type: 'text-delta', id: 't1', delta: '二' })
    await coalescer.flush()
    expect(calls).toBe(2)
    await coalescer.dispose()
  })
})
