'use client'

import { QueryProviders } from '@repo/ui'
import type { ReactNode } from 'react'

/**
 * 前台 Query 装配：机制（错误统一 toast + Provider）在 `@repo/ui` 的 `QueryProviders`，
 * 这里只给**前台自己的策略** —— 数据 60 秒内视为新鲜（落地页 / 个人中心多是低频读）。
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  return <QueryProviders staleTime={60 * 1000}>{children}</QueryProviders>
}
