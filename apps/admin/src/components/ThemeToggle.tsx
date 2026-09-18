'use client'

import { ThemeToggle as ThemeToggleBase } from '@repo/ui'
import { useTheme } from '@/stores/theme.store'

/**
 * 主题切换入口：把 admin 的主题 hook 接到 `@repo/ui` 的受控组件上
 * （组件本体是共享的，状态用哪个 key 由 app 决定）。
 */
export function ThemeToggle() {
  const { mode, setMode } = useTheme()

  return <ThemeToggleBase mode={mode} onSelect={setMode} />
}
