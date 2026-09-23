"use client"

import { useCallback, useEffect, useRef, useState } from "react"

/** `useControllableState` 的入参（对齐 Radix 同名 hook 的 API 形状） */
export interface UseControllableStateParams<T> {
  /** 受控值：传入即为受控（由外部持有真值） */
  prop?: T | undefined
  /** 非受控初值 */
  defaultProp?: T | undefined
  /** 真值变化回调（非受控内部更新 / 受控外部通知都会走到） */
  onChange?: (state: T) => void
}

type SetStateFn<T> = (prevState?: T) => T

/**
 * 受控 / 非受控二合一的布尔或泛型状态，等价于 `@radix-ui/react-use-controllable-state`。
 *
 * 本仓库已从 Radix 迁移到 Base UI，不引入任何 `@radix-ui/*` 运行时依赖，
 * 故按第一性原理自建等价实现（语义与 Radix 一致）：
 * - 受控（`prop` 有值）：内部不持有真值，setter 只回调 `onChange`；
 * - 非受控：内部 useState 持有真值，setter 先更新内部状态再回调 `onChange`；
 * - setter 与 useState 一致，支持函数式更新 `setter((prev) => next)`。
 *
 * 典型场景：组件既允许调用方传入 `open` / `onOpenChange` 受控使用，
 * 又允许不传任何 prop 直接自管理（ai-elements 系列组件大量使用该模式）。
 */
export function useControllableState<T>({ prop, defaultProp, onChange }: UseControllableStateParams<T>) {
  const [uncontrolledProp, setUncontrolledProp] = useState<T | undefined>(defaultProp)
  const isControlled = prop !== undefined
  const value = isControlled ? prop : uncontrolledProp

  // onChange 放进 ref：避免调用方内联函数导致引用频繁变化
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  const setValue = useCallback(
    (next: T | SetStateFn<T>) => {
      const resolve = (prev: T | undefined) => (typeof next === "function" ? (next as SetStateFn<T>)(prev) : next)

      if (isControlled) {
        const nextValue = resolve(prop)
        if (nextValue !== prop) onChangeRef.current?.(nextValue as T)
        return
      }

      setUncontrolledProp((prev) => {
        const nextValue = resolve(prev)
        if (nextValue !== prev) onChangeRef.current?.(nextValue as T)
        return nextValue
      })
    },
    [isControlled, prop],
  )

  // `value` 在受控时来自 `prop`（非 undefined），非受控时由调用方保证 defaultProp 已给定；
  // 这里对齐 Radix 的 `as T`，让消费方拿到非 undefined 的 `T`，避免到处写守卫。
  return [value as T, setValue] as const
}
