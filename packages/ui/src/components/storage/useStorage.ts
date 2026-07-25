'use client'

import { getFileInfo, maybePromise } from '@repo/shared'
import type { FileInfo } from '@repo/shared'
import { App } from 'antd'
import type { UploadProps } from 'antd'
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
  fileItems: StorageFileItem[]
  first: StorageFileItem | null | undefined
}

export const useStorage = (
  options: UseStorageOptions = {},
): UseStorageResult => {
  const { getPresignedUpload } = useStorageAdapter()
  const [fileItems, setFileItems] = useImmer<StorageFileItem[]>([])
  const { message } = App.useApp()

  const customRequest: NonNullable<UploadProps['customRequest']> = async ({
    file,
    onError,
    onProgress,
    onSuccess,
  }) => {
    const uploadFile = file as File

    try {
      if (
        options.sizeLimit !== undefined &&
        uploadFile.size > options.sizeLimit * 1024 * 1024
      ) {
        throw new Error(`文件大小不能超过 ${options.sizeLimit} MB`)
      }

      const fileInfo = await getFileInfo(uploadFile)
      const key = `${fileInfo.md5}${fileInfo.ext ?? ''}`
      const presigned = await getPresignedUpload(key)

      onProgress?.({ percent: 0 })
      const response = await fetch(presigned.url, {
        method: 'PUT',
        body: uploadFile,
        headers: uploadFile.type
          ? { 'Content-Type': uploadFile.type }
          : undefined,
      })

      if (!response.ok) {
        throw new Error(`文件上传失败（HTTP ${response.status}）`)
      }

      const newFileItems = options.singleFile
        ? [{ file: uploadFile, fileInfo, key }]
        : [...fileItems, { file: uploadFile, fileInfo, key }]

      setFileItems(newFileItems)
      await maybePromise(options.onChange?.(newFileItems))
      onProgress?.({ percent: 100 })
      onSuccess?.({ key: presigned.key }, uploadFile)
    } catch (error) {
      const uploadError =
        error instanceof Error ? error : new Error('文件上传失败')
      message.error(uploadError.message)
      onError?.(uploadError)
    }
  }

  return {
    customRequest,
    fileItems,
    first: options.singleFile ? fileItems.at(0) : null,
  }
}
