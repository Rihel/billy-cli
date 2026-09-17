import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useStream } from '../src/hooks/use-stream.ts'
import type { StreamClientLike } from '../src/hooks/use-stream.ts'

/** 内置状态事件名（与 hook 的约定一致） */
const STATE_EVENTS = ['open', 'reconnecting', 'closed']

/**
 * 手写替身：只实现 `useStream` 依赖的四项能力。
 * 用它（而不是 `HttpStreamClient`）测 hook，正好验证 `@repo/ui` 不依赖传输包这一设计。
 */
class FakeStreamClient implements StreamClientLike {
  currentState = 'idle'
  connectCount = 0
  closeCount = 0
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>()

  on(event: string, handler: (data: unknown) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  }

  connect(): void {
    this.connectCount += 1
    this.currentState = 'connecting'
  }

  close(): void {
    this.closeCount += 1
    this.currentState = 'closed'
    this.dispatch('closed')
    this.listeners.clear()
  }

  /** 模拟推流到达：状态事件会同步 currentState（与 HttpStreamClient 一致，先改状态再分发） */
  emit(event: string, data?: unknown): void {
    if (STATE_EVENTS.includes(event)) this.currentState = event
    this.dispatch(event, data)
  }

  private dispatch(event: string, data?: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) handler(data)
  }
}

describe('useStream', () => {
  it('挂载即建连，并把状态同步为 connecting', () => {
    const client = new FakeStreamClient()

    const { result } = renderHook(() => useStream(client))

    expect(client.connectCount).toBe(1)
    expect(result.current.state).toBe('connecting')
    expect(result.current.connected).toBe(false)
  })

  it('内置状态事件驱动 state / connected 更新', () => {
    const client = new FakeStreamClient()
    const { result } = renderHook(() => useStream(client))

    act(() => client.emit('open'))
    expect(result.current.state).toBe('open')
    expect(result.current.connected).toBe(true)

    act(() => client.emit('reconnecting'))
    expect(result.current.state).toBe('reconnecting')
    expect(result.current.connected).toBe(false)

    act(() => client.emit('closed'))
    expect(result.current.state).toBe('closed')
  })

  it('业务事件把 data 交给对应 handler，未订阅的事件不报错', () => {
    const client = new FakeStreamClient()
    const onAlert = vi.fn()
    renderHook(() => useStream(client, { 'alert.fired': onAlert }))

    act(() => client.emit('alert.fired', { title: '磁盘告警' }))
    act(() => client.emit('other.event', { ignored: true }))

    expect(onAlert).toHaveBeenCalledTimes(1)
    expect(onAlert).toHaveBeenCalledWith({ title: '磁盘告警' })
  })

  it('handler 实现变化不触发重连，但调用的是最新实现', () => {
    const client = new FakeStreamClient()
    const first = vi.fn()
    const second = vi.fn()

    const { rerender } = renderHook(
      ({ handler }) => useStream(client, { 'alert.fired': handler }),
      { initialProps: { handler: first as (data: unknown) => void } },
    )

    act(() => client.emit('alert.fired'))
    expect(first).toHaveBeenCalledTimes(1)

    // 同一个事件名集合，只有函数身份变化：不应重连
    rerender({ handler: second as (data: unknown) => void })
    expect(client.connectCount).toBe(1)

    act(() => client.emit('alert.fired'))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(client.closeCount).toBe(0)
  })

  it('订阅的事件名集合变化会重建订阅（重连一次）', () => {
    const client = new FakeStreamClient()

    const { rerender } = renderHook(
      ({ events }) => useStream(client, events),
      { initialProps: { events: { a: () => {} } as Record<string, () => void> } },
    )

    rerender({ events: { a: () => {}, b: () => {} } })

    expect(client.connectCount).toBe(2)
    expect(client.closeCount).toBe(1)
  })

  it('client 引用变化时关旧连新', () => {
    const first = new FakeStreamClient()
    const second = new FakeStreamClient()

    const { rerender } = renderHook(
      ({ client }) => useStream(client),
      { initialProps: { client: first as FakeStreamClient } },
    )

    rerender({ client: second })

    expect(first.closeCount).toBe(1)
    expect(second.connectCount).toBe(1)
  })

  it('卸载时 close 恰好一次，且不再响应后续事件', () => {
    const client = new FakeStreamClient()
    const onAlert = vi.fn()

    const { unmount } = renderHook(() => useStream(client, { 'alert.fired': onAlert }))
    unmount()

    expect(client.closeCount).toBe(1)
    act(() => client.emit('alert.fired', { title: '卸载后的事件' }))
    expect(onAlert).not.toHaveBeenCalled()
  })

  it('client 为 null 时不建连，状态为 idle', () => {
    const { result } = renderHook(() => useStream(null, { 'alert.fired': () => {} }))

    expect(result.current.state).toBe('idle')
    expect(result.current.connected).toBe(false)
  })
})
