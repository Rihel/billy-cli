'use client'

import { createContext, type ReactNode, useContext } from 'react'

export type PresignedUpload = {
  key: string
  url: string
}

export type StorageAdapter = {
  getPresignedUpload(key: string): Promise<PresignedUpload>
  /**
   * key → 可直接放进 `src` / `href` 的地址。
   * 桶私有后**不再**返回对象存储的公开地址；保留它只为兼容绝对 URL（http/https）与
   * 未注入 `getViewUrl` 的旧用法。
   */
  resolveUrl(key: string): string
  /**
   * key → **短时预签名**访问 URL（桶私有 + 鉴权下载）。
   *
   * 可选：未注入时使用方退回 `resolveUrl`（兼容旧行为）。异步是因为签名要问服务端。
   */
  getViewUrl?(key: string): Promise<string>
}

const StorageContext = createContext<StorageAdapter | null>(null)

export type StorageProviderProps = StorageAdapter & {
  children: ReactNode
}

/** 对象存储适配器 Provider（预签名上传 + 短时访问地址） */
export function StorageProvider({
  children,
  getPresignedUpload,
  resolveUrl,
  getViewUrl,
}: StorageProviderProps) {
  return (
    <StorageContext.Provider value={{ getPresignedUpload, resolveUrl, getViewUrl }}>
      {children}
    </StorageContext.Provider>
  )
}

export const useStorageAdapter = () => {
  const adapter = useContext(StorageContext)
  if (!adapter) {
    throw new Error('Storage components must be used within StorageProvider')
  }
  return adapter
}

/**
 * 不抛错的版本：给「有 provider 就签地址、没有也能渲染」的展示型组件用
 * （如聊天附件小卡 —— 单测 / 嵌入场景不一定挂了 StorageProvider）。
 */
export const useOptionalStorageAdapter = (): StorageAdapter | null => useContext(StorageContext)
