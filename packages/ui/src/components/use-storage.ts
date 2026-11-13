'use client'

import { maybePromise } from '@repo/shared'
import { getFileInfo } from '@repo/shared/browser'
import type { FileInfo } from '@repo/shared/browser'
import { produce } from 'immer'
import { useRef } from 'react'
import { useImmer } from 'use-immer'

import { toastError } from '#components/toast'
import { useStorageAdapter } from '#components/storage-provider'

export type StorageFileItem = {
  file: File
  key: string
  fileInfo: FileInfo | null
}

export type UseStorageOptions = {
  singleFile?: boolean
  /** 文件大小上限，单位 MB */
  sizeLimit?: number
  onChange?: (fileItems: StorageFileItem[]) => void | Promise<void>
}

export type UseStorageResult = {
  uploadFile: (file: File) => Promise<StorageFileItem>
  fileItems: StorageFileItem[]
  first: StorageFileItem | null | undefined
}

/** 文件上传核心逻辑：md5 去重 key + 预签名直传，配合 ImageUpload / FileUpload 使用 */
export const useStorage = (options: UseStorageOptions = {}): UseStorageResult => {
  const { getPresignedUpload } = useStorageAdapter()
  const [fileItems, setFileItems] = useImmer<StorageFileItem[]>([])
  const fileItemsRef = useRef<StorageFileItem[]>([])

  const uploadFile = async (file: File): Promise<StorageFileItem> => {
    try {
      if (options.sizeLimit !== undefined && file.size > options.sizeLimit * 1024 * 1024) {
        throw new Error(`文件大小不能超过 ${options.sizeLimit} MB`)
      }

      const fileInfo = await getFileInfo(file)
      const key = `${fileInfo.md5}${fileInfo.ext ?? ''}`
      const presigned = await getPresignedUpload(key)

      const response = await fetch(presigned.url, {
        method: 'PUT',
        body: file,
        headers: file.type ? { 'Content-Type': file.type } : undefined,
      })

      if (!response.ok) {
        throw new Error(`文件上传失败（HTTP ${response.status}）`)
      }

      const nextItem = { file, fileInfo, key: presigned.key }
      const newFileItems = produce(fileItemsRef.current, (draft) => {
        if (options.singleFile) draft.splice(0, draft.length, nextItem)
        else if (!draft.some((item) => item.key === nextItem.key)) draft.push(nextItem)
      })

      fileItemsRef.current = newFileItems
      setFileItems(newFileItems)
      await maybePromise(options.onChange?.(newFileItems))
      return nextItem
    } catch (error) {
      const uploadError = error instanceof Error ? error : new Error('文件上传失败')
      toastError(uploadError.message)
      throw uploadError
    }
  }

  return {
    uploadFile,
    fileItems,
    first: options.singleFile ? fileItems.at(0) : null,
  }
}
