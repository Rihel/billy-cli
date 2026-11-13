/**
 * 主题的纯逻辑与「水合前脚本」—— **不带 'use client'**，服务端组件也能 import
 * （根 layout 要用 `createThemeBootScript()` 生成防闪烁的内联脚本）。
 *
 * React 侧（hook / 组件）在 `#components/theme.tsx`，两者共用本文件的判定与读写。
 */

/** 主题模式：浅色 / 深色 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system'

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

/** 系统深色偏好的媒体查询（同时给 initTheme 监听用） */
export const PREFERS_DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)'

/**
 * 解析某模式是否应呈现深色：
 * `system` 跟随系统偏好；显式传 `prefersDark` 便于测试；SSR（无 window）回落浅色。
 */
export function resolveDark(mode: ThemeMode, prefersDark?: boolean): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  if (prefersDark !== undefined) return prefersDark
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(PREFERS_DARK_MEDIA_QUERY).matches
}

/** 切换 <html> 上的 .dark（设计系统的深色 token 挂在 `.dark` 选择器上） */
export function applyThemeClass(dark: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', dark)
}

/** 读取已存储的模式；无值 / 值非法 / 存储不可用（隐私模式）时回落 `defaultMode` */
export function readStoredMode(storageKey: string, defaultMode: ThemeMode): ThemeMode {
  try {
    const stored = localStorage.getItem(storageKey)
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored
    }
  } catch {
    // 忽略隐私模式等存储异常
  }
  return defaultMode
}

/** 持久化模式（失败静默：内存态仍然生效，只是刷新后回到默认） */
export function writeStoredMode(storageKey: string, mode: ThemeMode): void {
  try {
    localStorage.setItem(storageKey, mode)
  } catch {
    // 忽略存储异常
  }
}

/**
 * 生成「水合前」内联脚本（放进根 layout 的 `<script dangerouslySetInnerHTML>`）。
 *
 * 为什么必须有：深色模式下刷新页面时，React 水合前会先按浅色渲染一帧 —— 白屏闪一下（FOUC）。
 * 这段脚本在解析阶段就把 `.dark` 打上去。**存储 key 由调用方传入**，各前端互不干扰。
 */
export function createThemeBootScript(options: {
  storageKey: string
  defaultMode?: ThemeMode
}): string {
  const key = JSON.stringify(options.storageKey)
  const fallback = JSON.stringify(options.defaultMode ?? 'system')
  return (
    `(function(){try{var k=${key},t=localStorage.getItem(k)||${fallback};` +
    `var d=t==='dark'||(t==='system'&&window.matchMedia('${PREFERS_DARK_MEDIA_QUERY}').matches);` +
    `document.documentElement.classList.toggle('dark',d)}catch(e){}})()`
  )
}
