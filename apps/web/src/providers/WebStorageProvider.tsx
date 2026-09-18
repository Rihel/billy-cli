'use client'

import { StorageClientProvider } from '@repo/ui'
import type { ReactNode } from 'react'
import { formatStorageUrl } from '@/lib/constants'
import { useServerClient } from '@/lib/server-client'

/**
 * 对象存储适配器：把 `@repo/ui` 的上传组件（`ImageUpload` / `FileUpload` / `useStorage`）
 * 接到后端预签名接口上。
 *
 * 为什么必须显式装配：`@repo/ui` 不依赖 `@repo/sdk`（表现层不绑传输层），
 * 上传时「向谁要预签名」由应用注入；注入方式本身收口在 `StorageClientProvider`。
 */
export function WebStorageProvider({ children }: { children: ReactNode }) {
  return (
    <StorageClientProvider client={useServerClient()} resolveUrl={formatStorageUrl}>
      {children}
    </StorageClientProvider>
  )
}
