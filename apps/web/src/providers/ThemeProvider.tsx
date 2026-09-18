'use client'

import { useEffect, type ReactNode } from 'react'
import { initTheme } from '@/stores/theme'

/**
 * 主题初始化（渲染无副作用，只挂一次 effect）：应用已存储 / 系统的主题，并监听系统偏好变化。
 * 防闪烁靠根 layout 里的内联脚本，这里负责「客户端运行期间的跟随」。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    initTheme()
  }, [])

  return children
}
