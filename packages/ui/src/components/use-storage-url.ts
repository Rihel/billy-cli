'use client'

import { useEffect, useState } from 'react'

import { useStorageAdapter } from '#components/storage-provider.tsx'

/** 已经是完整地址（外链 / 服务端下发的预签名 URL）：原样使用，不再二次签名 */
const isAbsoluteUrl = (key: string): boolean => /^https?:\/\//i.test(key)

/**
 * 对象 key → 可访问 URL（**短时预签名**）。
 *
 * 背景（2026-11-14 评审整改）：对象存储桶改为默认私有后，`${bucket}/${key}` 这类公开地址
 * 不再可用；预览 / 下载必须问服务端要一次预签名 URL。
 *
 * 行为：
 * - key 是绝对地址（`http(s)://…`）→ 原样返回（不再请求）；
 * - 适配器注入了 `getViewUrl` → 异步取预签名 URL，取到前返回 `undefined`（调用方渲染占位）；
 * - 未注入（旧用法）→ 退回 `resolveUrl`，保持兼容。
 */
export function useStorageUrl(key?: string | null): string | undefined {
  const { getViewUrl, resolveUrl } = useStorageAdapter()
  const [url, setUrl] = useState<string | undefined>(() =>
    key && (isAbsoluteUrl(key) || !getViewUrl) ? resolveUrl(key) : undefined,
  )

  useEffect(() => {
    if (!key) {
      setUrl(undefined)
      return
    }
    if (isAbsoluteUrl(key) || !getViewUrl) {
      setUrl(resolveUrl(key))
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const next = await getViewUrl(key)
        if (!cancelled) setUrl(next)
      } catch {
        // 取不到签名（权限 / 网络）时保持 undefined，由调用方显示占位 / 图标
        if (!cancelled) setUrl(undefined)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [key, getViewUrl, resolveUrl])

  return url
}
