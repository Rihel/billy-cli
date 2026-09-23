import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useControllableState } from '../src/hooks/use-controllable-state.ts'

/**
 * 自建的 `useControllableState`（替代 `@radix-ui/react-use-controllable-state`）。
 *
 * ai-elements 的 chain-of-thought / reasoning / mic-selector / voice-selector / stack-trace /
 * transcription 都依赖它：受控时只回调 onChange，非受控时内部持有真值，且都支持函数式更新。
 * 这里把这三条对外语义钉住，避免以后「顺手换回 Radix」或改坏内部实现而无人发现。
 */
describe('useControllableState', () => {
  it('非受控：内部持有真值，setter 先更新内部状态再回调 onChange', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() =>
      useControllableState<boolean>({ defaultProp: false, onChange })
    )

    expect(result.current[0]).toBe(false)

    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('受控：以 prop 为真值，setter 不落内部状态只回调 onChange', () => {
    const onChange = vi.fn()
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) =>
        useControllableState<boolean>({ prop: open, defaultProp: false, onChange }),
      { initialProps: { open: false } }
    )

    act(() => result.current[1](true))
    // 受控下没有父组件改 prop，值保持不变
    expect(result.current[0]).toBe(false)
    expect(onChange).toHaveBeenCalledWith(true)

    rerender({ open: true })
    expect(result.current[0]).toBe(true)
  })

  it('setter 支持函数式更新（等价 useState 的 prev => next）', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() =>
      useControllableState<number>({ defaultProp: 1, onChange })
    )

    act(() => result.current[1]((prev) => (prev ?? 0) + 1))
    expect(result.current[0]).toBe(2)
    expect(onChange).toHaveBeenCalledWith(2)
  })

  it('值未变化时不触发 onChange（对齐 Radix 的浅比较）', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() =>
      useControllableState<boolean>({ defaultProp: false, onChange })
    )

    act(() => result.current[1](false))
    expect(onChange).not.toHaveBeenCalled()
  })
})
