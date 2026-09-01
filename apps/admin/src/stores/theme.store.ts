'use client'

import { create } from 'zustand'

/** 主题模式：浅色 / 深色 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'billy-admin-theme'

const MEDIA_QUERY = '(prefers-color-scheme: dark)'

/** 解析某模式是否应呈现深色（system 时跟随系统偏好） */
export function resolveDark(mode: ThemeMode): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  if (typeof window === 'undefined') return false
  return window.matchMedia(MEDIA_QUERY).matches
}

export function applyThemeClass(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark)
}

export function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored
    }
  } catch {
    // 忽略隐私模式等异常
  }
  return 'system'
}

type ThemeState = {
  mode: ThemeMode
  dark: boolean
  setMode: (mode: ThemeMode) => void
  /** 浅色 → 深色 → 跟随系统 → 浅色，循环切换 */
  cycle: () => void
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: 'system',
  dark: false,

  setMode: (mode) => {
    const dark = resolveDark(mode)
    applyThemeClass(dark)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode)
    } catch {
      // 忽略存储异常
    }
    set({ mode, dark })
  },

  cycle: () => {
    const order: ThemeMode[] = ['light', 'dark', 'system']
    const current = get().mode
    const next = order[(order.indexOf(current) + 1) % order.length] ?? 'light'
    get().setMode(next)
  },
}))

/** 客户端初始化：应用存储的 / 系统主题，并跟随系统变化（仅 system 模式） */
export function initTheme() {
  const mode = readStoredMode()
  const dark = resolveDark(mode)
  applyThemeClass(dark)
  useThemeStore.setState({ mode, dark })

  window.matchMedia(MEDIA_QUERY).addEventListener('change', () => {
    if (useThemeStore.getState().mode === 'system') {
      const nextDark = resolveDark('system')
      applyThemeClass(nextDark)
      useThemeStore.setState({ dark: nextDark })
    }
  })
}
