// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyThemeClass,
  createThemeBootScript,
  readStoredMode,
  resolveDark,
  writeStoredMode,
} from '../src/lib/theme.ts'

/**
 * 主题的纯逻辑与「水合前脚本」（node 环境：这里刻意不碰 React，只看判定与 DOM/存储副作用）。
 * React 侧（`useTheme`）见 `theme-hook.test.tsx`。
 */
describe('resolveDark', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('dark 模式恒为深色，不依赖系统偏好', () => {
    expect(resolveDark('dark')).toBe(true)
  })

  it('light 模式恒为浅色，不依赖系统偏好', () => {
    expect(resolveDark('light')).toBe(false)
  })

  it('system 模式跟随系统深色偏好', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
    expect(resolveDark('system')).toBe(true)

    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    expect(resolveDark('system')).toBe(false)
  })

  it('SSR（无 window）时 system 回落浅色，不抛错', () => {
    expect(typeof window).toBe('undefined')
    expect(resolveDark('system')).toBe(false)
  })
})

describe('createThemeBootScript', () => {
  it('带上存储 key，并在解析阶段就切换 .dark（防刷新白闪）', () => {
    const script = createThemeBootScript({ storageKey: 'billy-theme' })

    expect(script).toContain('"billy-theme"')
    expect(script).toContain("classList.toggle('dark'")
    expect(script.startsWith('(function(){try{')).toBe(true)
  })

  it('默认模式可指定（无存储值时用它判定）', () => {
    expect(createThemeBootScript({ storageKey: 'k', defaultMode: 'light' })).toContain('"light"')
    expect(createThemeBootScript({ storageKey: 'k' })).toContain('"system"')
  })
})

describe('主题读写与 createTheme.initTheme', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('readStoredMode：非法值 / 存储不可用时回落默认模式', () => {
    vi.stubGlobal('localStorage', { getItem: () => '紫色' })
    expect(readStoredMode('k', 'system')).toBe('system')

    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('隐私模式')
      },
    })
    expect(readStoredMode('k', 'light')).toBe('light')
  })

  it('writeStoredMode：写入失败静默（不阻断界面切换）', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('配额满')
      },
    })
    expect(() => writeStoredMode('k', 'dark')).not.toThrow()
  })

  it('applyThemeClass：无 document（SSR）时不抛错', () => {
    expect(typeof document).toBe('undefined')
    expect(() => applyThemeClass(true)).not.toThrow()
  })
})
