'use client'

import { UserAvatar, useStorageUrl } from '@repo/ui'

export type StorageAvatarProps = {
  /** 对象存储 key（不是 URL）：内部按需换短时预签名地址 */
  src?: string | null
  name?: string | null
  shape?: 'circle' | 'rounded'
  className?: string
}

/**
 * 头像（对象存储 key 版）。
 *
 * 桶私有后，`formatStorageUrl(key)` 拼出来的公开地址不再可访问；表格 / 侧栏这类
 * 直接吃 key 的位置统一走这里：`useStorageUrl` 先签地址，拿到前 `UserAvatar` 显示首字符兜底。
 */
export function StorageAvatar({ src, name, shape, className }: StorageAvatarProps) {
  const url = useStorageUrl(src)
  return <UserAvatar src={url ?? null} name={name} shape={shape} className={className} />
}
