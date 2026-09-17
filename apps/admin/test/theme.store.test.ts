import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDark } from '../src/stores/theme.store.ts'

/**
 * admin 纯逻辑测试样板（node 环境）。
 * `resolveDark` 是三态主题（浅色 / 深色 / 跟随系统）的判定核心，
 * 页面与 `initTheme` 都依赖它，回归风险高。
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
