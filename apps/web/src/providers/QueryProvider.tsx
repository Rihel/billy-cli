'use client'

import { QueryProviders, OverlayScrollbar } from '@repo/ui'
import type { ReactNode } from 'react'

/**
 * 前台 Query 装配：机制（错误统一 toast + Provider）在 `@repo/ui` 的 `QueryProviders`，
 * 这里只给**前台自己的策略** —— 数据 60 秒内视为新鲜（落地页 / 个人中心多是低频读）。
 *
 * 另挂 `OverlayScrollbar`：macOS 式覆盖滚动条（滚动时才淡入、只跟随被滚的容器），
 * 与后台同一套口径（视觉在 `@repo/ui` 的 globals.css）。
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  return (
    <QueryProviders staleTime={60 * 1000}>
      <OverlayScrollbar />
      {children}
    </QueryProviders>
  )
}
