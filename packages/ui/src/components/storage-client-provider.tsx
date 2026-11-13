'use client'

import type { ReactNode } from 'react'

import { StorageProvider, type PresignedUpload } from '#components/storage-provider'

/**
 * 结构化接口：只要求「客户端有个 `storage.getPresignedUrl`」，**不 import `@repo/sdk`** ——
 * 表现层库不绑传输包（与 `useStream` 的 `StreamClientLike` 同一取舍），
 * 应用可以注入自定义实现（测试替身 / 其它存储协议）。
 */
export type PresignedUploadClientLike = {
  storage: {
    getPresignedUrl(input: { key: string }): Promise<PresignedUpload>
  }
}

export type StorageClientProviderProps = {
  /** 应用侧的 SDK 客户端（如 `useServerClient()`） */
  client: PresignedUploadClientLike
  /** key → 可访问 URL（应用侧通常传 `formatStorageUrl`） */
  resolveUrl: (key: string) => string
  children: ReactNode
}

/**
 * 把 SDK 客户端接到上传组件上（`ImageUpload` / `FileUpload` / `useStorage` 依赖它的上下文）。
 *
 * 为什么需要它：`@repo/ui` 不依赖 sdk，所以「向谁要预签名」必须由应用注入；
 * 而注入方式（`storage.getPresignedUrl({ key })` + `resolveUrl`）属于**机制**，
 * 两个前端曾各抄一份，这里收口成一处。
 */
export function StorageClientProvider({
  client,
  resolveUrl,
  children,
}: StorageClientProviderProps) {
  return (
    <StorageProvider
      getPresignedUpload={(key) => client.storage.getPresignedUrl({ key })}
      resolveUrl={resolveUrl}
    >
      {children}
    </StorageProvider>
  )
}
