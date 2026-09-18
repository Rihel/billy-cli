import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTheme } from '../src/components/theme.tsx'

/**
 * 主题 hook（jsdom 环境）：`useTheme` 是各前端唯一的状态入口，
 * 它必须把 setMode / cycle 落到 `<html class="dark">` 与 localStorage 上。
 */
describe('useTheme', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark')
    vi.unstubAllGlobals()
  })

  it('setMode 切换 .dark 并持久化到调用方给的 key', () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem })

    const { useTheme } = createTheme({ storageKey: 'app-theme' })
    const { result } = renderHook(() => useTheme())

    act(() => result.current.setMode('dark'))
    expect(result.current.mode).toBe('dark')
    expect(result.current.dark).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(setItem).toHaveBeenCalledWith('app-theme', 'dark')

    act(() => result.current.setMode('light'))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('cycle 按 浅色 → 深色 → 跟随系统 → 浅色 轮转', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    })

    const { useTheme } = createTheme({ storageKey: 'app-theme' })
    const { result } = renderHook(() => useTheme())

    act(() => result.current.setMode('light'))
    act(() => result.current.cycle())
    expect(result.current.mode).toBe('dark')
    act(() => result.current.cycle())
    expect(result.current.mode).toBe('system')
    act(() => result.current.cycle())
    expect(result.current.mode).toBe('light')
  })

  it('initTheme 按已存储的模式切换 .dark（含 system 跟随系统）', () => {
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: true, addEventListener: () => {} }),
    })

    const stored = (value: string | null) =>
      vi.stubGlobal('localStorage', { getItem: () => value, setItem: () => {} })

    stored('dark')
    createTheme({ storageKey: 'k' }).initTheme()
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    stored('light')
    createTheme({ storageKey: 'k' }).initTheme()
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    // 无存储值 + system + 系统深色偏好 → 深色
    stored(null)
    createTheme({ storageKey: 'k' }).initTheme()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('两个 app 用不同 key 时互不干扰（同域 localStorage 共享）', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    })

    const web = createTheme({ storageKey: 'web-theme' })
    const admin = createTheme({ storageKey: 'admin-theme' })
    const webHook = renderHook(() => web.useTheme())
    const adminHook = renderHook(() => admin.useTheme())

    act(() => webHook.result.current.setMode('dark'))
    act(() => adminHook.result.current.setMode('light'))

    expect(store.get('web-theme')).toBe('dark')
    expect(store.get('admin-theme')).toBe('light')
  })
})
