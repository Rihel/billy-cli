'use client'

import { maybePromise } from '@repo/shared'
import { getFileInfo } from '@repo/shared/browser'
import type { FileInfo } from '@repo/shared/browser'
import { App } from 'antd'
import type { UploadProps } from 'antd'
import { produce } from 'immer'
import { useRef } from 'react'
import { useImmer } from 'use-immer'
import { useStorageAdapter } from './StorageProvider'

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
  customRequest: NonNullable<UploadProps['customRequest']>
  uploadFile: (file: File) => Promise<StorageFileItem>
  fileItems: StorageFileItem[]
  first: StorageFileItem | null | undefined
}

export const useStorage = (
  options: UseStorageOptions = {},
): UseStorageResult => {
  const { getPresignedUpload } = useStorageAdapter()
  const [fileItems, setFileItems] = useImmer<StorageFileItem[]>([])
  const fileItemsRef = useRef<StorageFileItem[]>([])
  const { message } = App.useApp()

  const uploadFile = async (file: File): Promise<StorageFileItem> => {
    try {
      if (
        options.sizeLimit !== undefined &&
        file.size > options.sizeLimit * 1024 * 1024
      ) {
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
        else if (!draft.some((item) => item.key === nextItem.key))
          draft.push(nextItem)
      })

      fileItemsRef.current = newFileItems
      setFileItems(newFileItems)
      await maybePromise(options.onChange?.(newFileItems))
      return nextItem
    } catch (error) {
      const uploadError =
        error instanceof Error ? error : new Error('文件上传失败')
      message.error(uploadError.message)
      throw uploadError
    }
  }

  const customRequest: NonNullable<UploadProps['customRequest']> = async ({
    file,
    onError,
    onProgress,
    onSuccess,
  }) => {
    const uploadTarget = file as File

    try {
      onProgress?.({ percent: 0 })
      const fileItem = await uploadFile(uploadTarget)
      onProgress?.({ percent: 100 })
      onSuccess?.({ key: fileItem.key }, uploadTarget)
    } catch (error) {
      const uploadError =
        error instanceof Error ? error : new Error('文件上传失败')
      onError?.(uploadError)
    }
  }

  return {
    customRequest,
    uploadFile,
    fileItems,
    first: options.singleFile ? fileItems.at(0) : null,
  }
}
