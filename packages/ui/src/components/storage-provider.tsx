"use client"

import { createContext, type ReactNode, useContext } from "react"

export type PresignedUpload = {
  key: string
  url: string
}

export type StorageAdapter = {
  getPresignedUpload(key: string): Promise<PresignedUpload>
  resolveUrl(key: string): string
}

const StorageContext = createContext<StorageAdapter | null>(null)

export type StorageProviderProps = StorageAdapter & {
  children: ReactNode
}

/** 对象存储适配器 Provider（预签名上传 + 文件 URL 解析） */
export function StorageProvider({
  children,
  getPresignedUpload,
  resolveUrl,
}: StorageProviderProps) {
  return (
    <StorageContext.Provider value={{ getPresignedUpload, resolveUrl }}>
      {children}
    </StorageContext.Provider>
  )
}

export const useStorageAdapter = () => {
  const adapter = useContext(StorageContext)
  if (!adapter) {
    throw new Error("Storage components must be used within StorageProvider")
  }
  return adapter
}
