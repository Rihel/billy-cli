'use client'

import { ReactNode, useEffect } from 'react'
import { QueryProviders, StorageClientProvider, Toaster, TooltipProvider } from '@repo/ui'
import { formatStorageUrl } from '@/lib/constants'
import { useServerClient } from '@/lib/server-client'
import { initTheme } from '@/stores/theme.store'

function AppStorageProvider({ children }: { children: ReactNode }) {
  return (
    <StorageClientProvider client={useServerClient()} resolveUrl={formatStorageUrl}>
      {children}
    </StorageClientProvider>
  )
}

export type ProvidersProps = Partial<{
  children: ReactNode
}>

export const Providers = ({ children }: ProvidersProps) => {
  // 应用存储的 / 系统主题（浅色 / 深色 / 跟随系统），并监听系统偏好变化
  useEffect(() => {
    initTheme()
  }, [])

  return (
    <TooltipProvider>
      {/* QueryClient 装配（机制 + 错误统一 toast）在 @repo/ui；后台不设 staleTime（默认每次视为过期） */}
      <QueryProviders>
        <AppStorageProvider>{children}</AppStorageProvider>
      </QueryProviders>
      <Toaster />
    </TooltipProvider>
  )
}
